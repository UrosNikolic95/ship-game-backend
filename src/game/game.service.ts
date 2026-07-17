import {
  Injectable,
  Logger,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { WorldChunkEntity } from './entities/world-chunk.entity';
import { PortEntity } from './entities/port.entity';
import { ShipEntity } from './entities/ship.entity';
import { ShipInventoryEntity } from './entities/ship-inventory.entity';
import { PurchaseEntity } from './entities/purchase.entity';
import { BoatTypeEntity } from './entities/boat-type.entity';
import { BoatForSaleEntity } from './entities/boat-for-sale.entity';
import {
  GameState,
  MoneyRecord,
  Leaderboard,
  LeaderboardEntry,
  World,
  Player,
  Port,
  Resource,
  RESOURCES,
  RECORD_BOARD_SIZE,
  displayNameFor,
  BOATS,
  buyPrice,
  sellPrice,
  emptyInventory,
  emptyPurchases,
  findBoat,
  PORT_SHIPYARDS,
  DOCK_RADIUS,
  CHUNK_SIZE,
  PORT_MARGIN,
  chunkOf,
  mulberry32,
  hashChunk,
  generatePortName,
  generatePrices,
} from './game.types';

// Fixed world seed. Chunk content is generated deterministically from it, and
// every generated chunk and its ports are persisted, so the world is fully
// reconstructed from the database — the seed only needs to be stable enough to
// generate not-yet-visited chunks the same way, which a constant guarantees
// without needing its own row.
const WORLD_SEED = 0x9e3779b1;

// Legacy on-disk save locations. Data here is imported into the database once,
// the first time the server starts against an empty database, so existing
// progress survives the move from files to PostgreSQL.
const LEGACY_DIR = join(process.cwd(), 'data');
const LEGACY_WORLD_FILE = join(LEGACY_DIR, 'world.json');
const LEGACY_PLAYERS_DIR = join(LEGACY_DIR, 'players');

@Injectable()
export class GameService implements OnModuleInit {
  private readonly logger = new Logger(GameService.name);
  // The single world all players sail in, cached in memory and written through
  // to the database as chunks are explored.
  private world!: World;
  // Game-logic view of each loaded player, keyed by the user id from their cookie.
  private readonly players = new Map<string, Player>();
  // The managed ship row backing each loaded player, kept so that saving updates
  // the existing rows (and their child cargo/purchase rows) in place rather than
  // inserting duplicates.
  private readonly shipEntities = new Map<string, ShipEntity>();
  // The boat-type catalog, loaded once from the database and keyed by boat key,
  // so ships and ports can reference the managed rows when they are saved.
  private readonly boatTypes = new Map<string, BoatTypeEntity>();

  constructor(
    @InjectRepository(WorldChunkEntity)
    private readonly chunkRepo: Repository<WorldChunkEntity>,
    @InjectRepository(PortEntity)
    private readonly portRepo: Repository<PortEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipRepo: Repository<ShipEntity>,
    @InjectRepository(BoatTypeEntity)
    private readonly boatTypeRepo: Repository<BoatTypeEntity>,
  ) {}

  // The database connection isn't ready until Nest has finished wiring modules,
  // so load (or create) the shared world here rather than in the constructor.
  async onModuleInit(): Promise<void> {
    await this.seedBoatTypes();
    await this.importLegacyFilesIfEmpty();
    await this.backfillPeakGold();
    const loaded = await this.loadWorld();
    if (loaded) {
      this.world = loaded;
    } else {
      this.world = this.createWorld();
      await this.persistInitialWorld();
    }
  }

  // Make sure a player record exists for this user: load their saved ship, or
  // start a fresh player at the world's spawn. Called before every request.
  async ensureUser(userId: string): Promise<void> {
    if (this.players.has(userId)) return;
    const loaded = await this.loadPlayer(userId);
    if (loaded) {
      this.players.set(userId, loaded);
    } else {
      this.players.set(userId, this.createPlayer());
      await this.savePlayer(userId);
    }
  }

  getState(userId: string): GameState {
    return this.viewFor(userId);
  }

  // Ship rows created before peak-gold tracking existed default their high-water
  // mark to 0, which would keep every established player off the leaderboard
  // until their next save. A player currently holding gold has, by definition,
  // peaked at least that high — so seed the mark from current gold wherever it
  // lags behind. Runs once at startup and is idempotent (afterwards every row
  // has peakGold >= gold, so re-running changes nothing).
  private async backfillPeakGold(): Promise<void> {
    try {
      const result = await this.shipRepo
        .createQueryBuilder()
        .update(ShipEntity)
        .set({
          peakGold: () => '"gold"',
          peakGoldAt: () => 'COALESCE("peakGoldAt", now())',
        })
        .where('"peakGold" < "gold"')
        .execute();
      if (result.affected) {
        this.logger.log(`Backfilled peak gold for ${result.affected} ship(s)`);
      }
    } catch (err) {
      // Non-fatal: on a schema without the columns yet (synchronize off) the
      // leaderboard simply stays empty rather than crashing startup.
      this.logger.warn(`Peak-gold backfill skipped: ${String(err)}`);
    }
  }

  // The richest players ever: the top peak-gold high-water marks across every
  // player, best first. Ties go to whoever got there first. Read straight from
  // the database rather than the in-memory players, so it covers everyone —
  // including players who aren't currently loaded.
  async getMoneyRecords(): Promise<MoneyRecord[]> {
    // Hand-rolled query so the ship's eager cargo/purchase/boat relations aren't
    // dragged along for rows we only need two columns of.
    const rows = await this.shipRepo
      .createQueryBuilder('ship')
      .select(['ship.userId', 'ship.peakGold', 'ship.peakGoldAt'])
      .where('ship.peakGold > 0')
      .orderBy('ship.peakGold', 'DESC')
      .addOrderBy('ship.peakGoldAt', 'ASC')
      .take(RECORD_BOARD_SIZE)
      .getMany();

    return rows.map((r) => ({
      userId: r.userId,
      name: displayNameFor(r.userId),
      gold: r.peakGold,
      achievedAt: r.peakGoldAt ? r.peakGoldAt.toISOString() : null,
    }));
  }

  // The leaderboard for a given player: the top RECORD_BOARD_SIZE richest
  // players, plus — when this player didn't make that list — their own entry and
  // rank so they can still see where they stand. `currentUser` is null when the
  // player is already in `top` (their row there is flagged isCurrentUser), or
  // hasn't earned a place on the board yet.
  async getLeaderboard(userId: string): Promise<Leaderboard> {
    const records = await this.getMoneyRecords();
    const top: LeaderboardEntry[] = records.map((r, i) => ({
      rank: i + 1,
      name: r.name,
      gold: r.gold,
      achievedAt: r.achievedAt,
      isCurrentUser: r.userId === userId,
    }));

    // Already on the board — highlighted in place, no separate row needed.
    if (top.some((e) => e.isCurrentUser)) {
      return { top, currentUser: null };
    }

    return { top, currentUser: await this.rankOf(userId) };
  }

  // This player's own leaderboard entry and rank, for when they aren't in the
  // top list. Null when they haven't earned a place on the board (no ship saved
  // yet, or they've never held any gold).
  private async rankOf(userId: string): Promise<LeaderboardEntry | null> {
    // QueryBuilder (rather than findOne) so the ship's eager relations aren't
    // dragged along for the two columns we need.
    const me = await this.shipRepo
      .createQueryBuilder('ship')
      .select(['ship.userId', 'ship.peakGold', 'ship.peakGoldAt'])
      .where('ship.userId = :userId', { userId })
      .getOne();
    if (!me || me.peakGold <= 0) return null;

    // Rank is one more than the number of players strictly ahead, using the same
    // ordering as the board: more peak gold first, ties broken by who reached it
    // first. (When this player's timestamp is missing we skip the tie-break.)
    const aheadQuery = this.shipRepo
      .createQueryBuilder('ship')
      .where('ship.peakGold > :gold', { gold: me.peakGold });
    if (me.peakGoldAt) {
      aheadQuery.orWhere('ship.peakGold = :gold AND ship.peakGoldAt < :at', {
        gold: me.peakGold,
        at: me.peakGoldAt,
      });
    }
    const ahead = await aheadQuery.getCount();

    return {
      rank: ahead + 1,
      name: displayNameFor(me.userId),
      gold: me.peakGold,
      achievedAt: me.peakGoldAt ? me.peakGoldAt.toISOString() : null,
      isCurrentUser: true,
    };
  }

  // The player drives the ship client-side; we just persist where it ended up.
  // The world is unbounded, so there's no clamp — but we make sure the chunk the
  // ship now sits in exists (the client also requests this as it crosses edges).
  async moveShip(userId: string, x: number, y: number): Promise<GameState> {
    const player = this.playerOf(userId);
    player.ship.x = x;
    player.ship.y = y;
    await this.ensureChunk(chunkOf(x), chunkOf(y));
    await this.savePlayer(userId);
    return this.viewFor(userId);
  }

  async trade(
    userId: string,
    portId: string,
    resource: Resource,
    quantity: number,
    action: 'buy' | 'sell',
  ): Promise<GameState> {
    if (!RESOURCES.includes(resource)) {
      throw new BadRequestException(`Unknown resource: ${resource}`);
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }

    const player = this.playerOf(userId);
    const port = this.world.ports.find((p) => p.id === portId);
    if (!port) throw new BadRequestException(`Unknown port: ${portId}`);

    const ship = player.ship;
    const dist = Math.hypot(ship.x - port.x, ship.y - port.y);
    if (dist > DOCK_RADIUS) {
      throw new BadRequestException('Ship is not docked at this port');
    }

    const base = port.prices[resource];

    if (action === 'buy') {
      const unit = buyPrice(base);
      const cost = unit * quantity;
      if (cost > ship.gold) {
        throw new BadRequestException('Not enough gold');
      }
      if (this.cargoUsed(player) + quantity > ship.cargoCapacity) {
        throw new BadRequestException('Not enough cargo space');
      }
      ship.gold -= cost;
      ship.cargo[resource] += quantity;

      // Add the outlay to this resource's cost basis (money tied up in cargo).
      const stat = player.purchases.perResource[resource];
      stat.spent += cost;
      stat.quantity += quantity;
    } else {
      if (ship.cargo[resource] < quantity) {
        throw new BadRequestException('Not enough goods to sell');
      }
      const unit = sellPrice(base);
      ship.gold += unit * quantity;
      ship.cargo[resource] -= quantity;

      // Release the average *buy* cost of the units sold from the cost basis,
      // not the sale price. Selling everything zeroes the basis (avg -> 0).
      const stat = player.purchases.perResource[resource];
      const avg = stat.quantity > 0 ? stat.spent / stat.quantity : 0;
      stat.quantity -= quantity;
      stat.spent -= avg * quantity;
      if (stat.quantity <= 0) {
        stat.quantity = 0;
        stat.spent = 0;
      }
    }

    // Total spent reflects the cost basis of everything still in the hold.
    player.purchases.totalSpent = RESOURCES.reduce(
      (sum, r) => sum + player.purchases.perResource[r].spent,
      0,
    );

    await this.savePlayer(userId);
    return this.viewFor(userId);
  }

  // Upgrade the ship to a larger hull sold by the docked port's shipyard. The
  // old hull is traded in at full value, so the player pays only the difference.
  async buyShip(
    userId: string,
    portId: string,
    boatId: string,
  ): Promise<GameState> {
    const player = this.playerOf(userId);
    const port = this.world.ports.find((p) => p.id === portId);
    if (!port) throw new BadRequestException(`Unknown port: ${portId}`);

    const ship = player.ship;
    const dist = Math.hypot(ship.x - port.x, ship.y - port.y);
    if (dist > DOCK_RADIUS) {
      throw new BadRequestException('Ship is not docked at this port');
    }
    if (!port.boatIds.includes(boatId)) {
      throw new BadRequestException(
        "This port's shipyard does not sell that boat",
      );
    }

    const boat = findBoat(boatId);
    if (!boat) throw new BadRequestException(`Unknown boat: ${boatId}`);
    if (boat.cargoCapacity <= ship.cargoCapacity) {
      throw new BadRequestException('Your ship is already as large or larger');
    }

    // Trade in the current hull at full value: cost is just the difference.
    const tradeIn = findBoat(ship.boatId)?.price ?? 0;
    const cost = boat.price - tradeIn;
    if (cost > ship.gold) {
      throw new BadRequestException('Not enough gold');
    }

    ship.gold -= cost;
    ship.boatId = boat.id;
    ship.cargoCapacity = boat.cargoCapacity;
    await this.savePlayer(userId);
    return this.viewFor(userId);
  }

  // Reset only this player back to a fresh start. The shared world (map, ports,
  // explored chunks) is untouched, so one player resetting doesn't wipe the
  // world out from under everyone else.
  async reset(userId: string): Promise<GameState> {
    this.players.set(userId, this.createPlayer());
    await this.savePlayer(userId);
    return this.viewFor(userId);
  }

  // Compose the shared world and a player's own progress into the flat shape the
  // client expects.
  private viewFor(userId: string): GameState {
    const player = this.playerOf(userId);
    return {
      chunkSize: this.world.chunkSize,
      seed: this.world.seed,
      chunks: this.world.chunks,
      ports: this.world.ports,
      ship: player.ship,
      purchases: player.purchases,
    };
  }

  // Look up an already-loaded player. Callers must have run ensureUser first.
  private playerOf(userId: string): Player {
    const player = this.players.get(userId);
    if (!player) {
      // Should never happen: the controller calls ensureUser on every request.
      throw new BadRequestException('Unknown user session');
    }
    return player;
  }

  private cargoUsed(player: Player): number {
    return RESOURCES.reduce((sum, r) => sum + player.ship.cargo[r], 0);
  }

  // ---- world / player creation ---------------------------------------------

  private createWorld(): World {
    // Hand-placed ports with distinct price profiles so that hauling a good
    // from where it is cheap to where it is dear is always worthwhile. These
    // make up the starting chunk (0,0); everything beyond is generated on the fly.
    const ports: Port[] = [
      this.port('harbor', 'Old Harbor', 600, 700, {
        wood: 8,
        grain: 6,
        iron: 22,
        spice: 40,
        cloth: 18,
      }),
      this.port('saltmoor', 'Saltmoor', 3100, 900, {
        wood: 14,
        grain: 5,
        iron: 30,
        spice: 18,
        cloth: 12,
      }),
      this.port('ironcliff', 'Ironcliff', 1900, 1700, {
        wood: 20,
        grain: 12,
        iron: 9,
        spice: 33,
        cloth: 26,
      }),
      this.port('greenport', 'Greenport', 800, 3100, {
        wood: 7,
        grain: 14,
        iron: 26,
        spice: 28,
        cloth: 9,
      }),
      this.port('sunreach', 'Sunreach', 3300, 3200, {
        wood: 16,
        grain: 9,
        iron: 19,
        spice: 7,
        cloth: 30,
      }),
      this.port('mistbay', 'Mistbay', 2200, 2600, {
        wood: 11,
        grain: 8,
        iron: 15,
        spice: 24,
        cloth: 21,
      }),
    ];

    return {
      chunkSize: CHUNK_SIZE,
      seed: WORLD_SEED,
      // The curated starting area is chunk (0,0).
      chunks: [{ cx: 0, cy: 0 }],
      ports,
    };
  }

  private createPlayer(): Player {
    return {
      ship: {
        x: 850,
        y: 850,
        gold: 500,
        cargo: emptyInventory(),
        cargoCapacity: 50,
        boatId: 'sloop',
      },
      purchases: emptyPurchases(),
    };
  }

  // ---- chunk generation -----------------------------------------------------

  // Generate the chunk at (cx, cy) in the shared world if it doesn't exist yet,
  // appending its ports to the flat port list. Idempotent: re-requesting a chunk
  // is a no-op. Because the world is shared, any player can trigger this and the
  // new ports become visible to everyone.
  async ensureChunk(cx: number, cy: number): Promise<void> {
    if (this.world.chunks.some((c) => c.cx === cx && c.cy === cy)) {
      return;
    }
    const generated = this.generateChunk(cx, cy);
    try {
      await this.chunkRepo.save(this.chunkRepo.create({ cx, cy }));
      let savedPorts: Port[] = [];
      if (generated.length > 0) {
        const rows = await this.portRepo.save(
          generated.map((p) => this.portToEntity(p)),
        );
        // Re-read so the in-memory ports carry their database-assigned ids.
        savedPorts = rows.map((e) => this.entityToPort(e));
      }
      this.world.ports.push(...savedPorts);
      this.world.chunks.push({ cx, cy });
    } catch (err) {
      this.logger.error(`Failed to save chunk (${cx},${cy}): ${String(err)}`);
    }
  }

  // Procedurally place 1–3 ports inside a chunk, seeded so the same chunk always
  // produces the same ports. Chunk (0,0) is hand-made and never generated here.
  private generateChunk(cx: number, cy: number): Port[] {
    const rng = mulberry32(hashChunk(this.world.seed, cx, cy));
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    const span = CHUNK_SIZE - PORT_MARGIN * 2;

    const count = 1 + Math.floor(rng() * 3); // 1..3
    const ports: Port[] = [];
    let attempts = 0;
    while (ports.length < count && attempts < 30) {
      attempts++;
      const x = baseX + PORT_MARGIN + rng() * span;
      const y = baseY + PORT_MARGIN + rng() * span;
      // Keep ports inside a chunk spaced out so their dock rings don't overlap.
      if (ports.some((p) => Math.hypot(p.x - x, p.y - y) < 600)) continue;

      const i = ports.length;
      // ~25% of ports have a shipyard; bigger ports build bigger hulls.
      let boatIds: string[] = [];
      if (rng() < 0.25)
        boatIds = rng() < 0.4 ? ['cutter', 'trader'] : ['cutter'];

      ports.push({
        id: `port-${cx}-${cy}-${i}`,
        name: generatePortName(rng),
        x: Math.round(x),
        y: Math.round(y),
        prices: generatePrices(rng),
        boatIds,
      });
    }
    return ports;
  }

  private port(
    id: string,
    name: string,
    x: number,
    y: number,
    prices: Record<Resource, number>,
  ): Port {
    return { id, name, x, y, prices, boatIds: PORT_SHIPYARDS[id] ?? [] };
  }

  // ---- entity <-> domain mapping -------------------------------------------

  // Builds a port row from a domain port. The port's domain id is the database
  // id, assigned on insert, so it is not set here (it is filled in by
  // entityToPort once the row has been saved).
  private portToEntity(port: Port): PortEntity {
    return this.portRepo.create({
      name: port.name,
      x: port.x,
      y: port.y,
      priceWood: port.prices.wood,
      priceGrain: port.prices.grain,
      priceIron: port.prices.iron,
      priceSpice: port.prices.spice,
      priceCloth: port.prices.cloth,
      // One boat-for-sale row per hull this port's shipyard offers. Cascaded
      // through the port, so saving the port saves these too.
      boatsForSale: port.boatIds.map((boatId) =>
        this.portRepo.manager.create(BoatForSaleEntity, {
          boatType: this.boatTypeFor(boatId),
        }),
      ),
    });
  }

  private entityToPort(e: PortEntity): Port {
    return {
      // The client refers to a port by its database id (as a string).
      id: String(e.id),
      name: e.name,
      x: e.x,
      y: e.y,
      prices: {
        wood: e.priceWood,
        grain: e.priceGrain,
        iron: e.priceIron,
        spice: e.priceSpice,
        cloth: e.priceCloth,
      },
      boatIds: (e.boatsForSale ?? []).map((b) => this.boatIdOf(b.boatType)),
    };
  }

  // Build a fresh ship row (with its five cargo and five purchase rows) for a
  // user from the game-logic player. Used when persisting a player for the first
  // time; the returned entity has no ids until saved.
  private newShipEntity(userId: string, player: Player): ShipEntity {
    const entity = this.shipRepo.create({
      userId,
      x: player.ship.x,
      y: player.ship.y,
      gold: player.ship.gold,
      peakGold: player.ship.gold,
      peakGoldAt: new Date(),
      boatType: this.boatTypeFor(player.ship.boatId),
      inventory: RESOURCES.map(
        (r) => ({ resource: r, quantity: 0 }) as ShipInventoryEntity,
      ),
      purchases: RESOURCES.map(
        (r) => ({ resource: r, spent: 0, quantity: 0 }) as PurchaseEntity,
      ),
    });
    return entity;
  }

  private entityToPlayer(e: ShipEntity): Player {
    const cargo = emptyInventory();
    for (const inv of e.inventory) {
      if (RESOURCES.includes(inv.resource as Resource)) {
        cargo[inv.resource as Resource] = inv.quantity;
      }
    }

    const purchases = emptyPurchases();
    for (const pr of e.purchases) {
      if (RESOURCES.includes(pr.resource as Resource)) {
        purchases.perResource[pr.resource as Resource] = {
          spent: pr.spent,
          quantity: pr.quantity,
        };
      }
    }
    purchases.totalSpent = RESOURCES.reduce(
      (sum, r) => sum + purchases.perResource[r].spent,
      0,
    );

    return {
      ship: {
        x: e.x,
        y: e.y,
        gold: e.gold,
        cargo,
        // Cargo capacity is defined by the owned boat type.
        cargoCapacity: e.boatType.cargoCapacity,
        boatId: this.boatIdOf(e.boatType),
      },
      purchases,
    };
  }

  // ---- persistence ----------------------------------------------------------

  // Populate the boat-type catalog from the BOATS constant the first time the
  // server runs, then load every boat type into memory so ships and ports can
  // reference the managed rows. Idempotent across restarts.
  private async seedBoatTypes(): Promise<void> {
    if ((await this.boatTypeRepo.count()) === 0) {
      await this.boatTypeRepo.save(
        BOATS.map((b) =>
          this.boatTypeRepo.create({
            name: b.name,
            cargoCapacity: b.cargoCapacity,
            price: b.price,
          }),
        ),
      );
      this.logger.log(`Seeded ${BOATS.length} boat types`);
    }
    const rows = await this.boatTypeRepo.find();
    for (const row of rows) this.boatTypes.set(this.boatIdOf(row), row);
  }

  // The game's domain boat id for a boat type: the lower-cased hull name (e.g.
  // 'Cutter' -> 'cutter'), matching the ids in the shared BOATS catalog.
  private boatIdOf(boatType: BoatTypeEntity): string {
    return boatType.name.toLowerCase();
  }

  // The managed boat-type row for a domain boat id. Throws on an unknown id,
  // since every hull a ship or shipyard refers to must exist in the catalog.
  private boatTypeFor(boatId: string): BoatTypeEntity {
    const boatType = this.boatTypes.get(boatId);
    if (!boatType) {
      throw new Error(`Unknown boat type: ${boatId}`);
    }
    return boatType;
  }

  private async persistInitialWorld(): Promise<void> {
    try {
      await this.chunkRepo.save(
        this.world.chunks.map((c) => this.chunkRepo.create(c)),
      );
      const rows = await this.portRepo.save(
        this.world.ports.map((p) => this.portToEntity(p)),
      );
      // Re-read so the in-memory ports carry their database-assigned ids.
      this.world.ports = rows.map((e) => this.entityToPort(e));
      this.logger.log('Created and persisted the starting world');
    } catch (err) {
      this.logger.error(`Failed to persist initial world: ${String(err)}`);
    }
  }

  private async loadWorld(): Promise<World | null> {
    try {
      const chunkRows = await this.chunkRepo.find();
      if (chunkRows.length === 0) return null;
      const portRows = await this.portRepo.find();
      this.logger.log(
        `Loaded shared world (${chunkRows.length} chunks, ${portRows.length} ports)`,
      );
      return {
        chunkSize: CHUNK_SIZE,
        seed: WORLD_SEED,
        chunks: chunkRows.map((c) => ({ cx: c.cx, cy: c.cy })),
        ports: portRows.map((p) => this.entityToPort(p)),
      };
    } catch (err) {
      this.logger.warn(`Could not load world, starting fresh: ${String(err)}`);
      return null;
    }
  }

  private async loadPlayer(userId: string): Promise<Player | null> {
    try {
      const entity = await this.shipRepo.findOne({ where: { userId } });
      if (!entity) return null;
      // Hold onto the managed row so later saves update it (and its children) in
      // place instead of inserting duplicates.
      this.shipEntities.set(userId, entity);
      this.logger.log(`Loaded player ${userId}`);
      return this.entityToPlayer(entity);
    } catch (err) {
      this.logger.warn(
        `Could not load player ${userId}, starting fresh: ${String(err)}`,
      );
      return null;
    }
  }

  // Write a player's current state through to its ship row and the child cargo
  // and purchase rows. Reuses the cached managed entity when present so the same
  // rows are updated; otherwise creates fresh rows for a brand-new player.
  private async savePlayer(userId: string): Promise<void> {
    const player = this.players.get(userId);
    if (!player) return;

    let entity = this.shipEntities.get(userId);
    if (!entity) {
      entity = this.newShipEntity(userId, player);
      this.shipEntities.set(userId, entity);
    }

    entity.x = player.ship.x;
    entity.y = player.ship.y;
    entity.gold = player.ship.gold;
    // Raise the high-water mark whenever the player is holding more gold than
    // they ever have before. It is only ever raised — spending the gold back
    // down, or a reset, leaves the peak (and when it was reached) untouched, so
    // the record board reflects the best they've ever done.
    if (player.ship.gold > entity.peakGold) {
      entity.peakGold = player.ship.gold;
      entity.peakGoldAt = new Date();
    }
    entity.boatType = this.boatTypeFor(player.ship.boatId);
    for (const inv of entity.inventory) {
      inv.quantity = player.ship.cargo[inv.resource as Resource] ?? 0;
    }
    for (const pr of entity.purchases) {
      const stat = player.purchases.perResource[pr.resource as Resource];
      pr.spent = stat?.spent ?? 0;
      pr.quantity = stat?.quantity ?? 0;
    }

    try {
      // Cascade saves the ship and its cargo/purchase rows together.
      const saved = await this.shipRepo.save(entity);
      this.shipEntities.set(userId, saved);
    } catch (err) {
      this.logger.error(`Failed to save player ${userId}: ${String(err)}`);
    }
  }

  // ---- save-format normalization (legacy imports) ---------------------------

  // Patch up older saved shapes so legacy file data loads cleanly.
  private normalizeWorld(parsed: World): World {
    if (!parsed.chunks) parsed.chunks = [{ cx: 0, cy: 0 }];
    // Saves written before shipyards existed lack the boat fields.
    for (const port of parsed.ports) {
      if (!port.boatIds) port.boatIds = PORT_SHIPYARDS[port.id] ?? [];
    }
    return parsed;
  }

  private normalizePlayer(parsed: Player): Player {
    // Saves written before purchase tracking existed lack this field.
    if (!parsed.purchases) parsed.purchases = emptyPurchases();
    // Saves written before shipyards existed lack the boat field.
    if (!parsed.ship.boatId) parsed.ship.boatId = 'sloop';
    // Saves written before `qty` was renamed to `quantity` carry the old key.
    for (const r of RESOURCES) {
      const stat = parsed.purchases.perResource[r] as {
        spent: number;
        quantity?: number;
        qty?: number;
      };
      if (stat.quantity == null) stat.quantity = stat.qty ?? 0;
      delete stat.qty;
    }
    return parsed;
  }

  // ---- one-time legacy import -----------------------------------------------

  // The world and players used to be stored as JSON files under data/. The first
  // time the server runs against an empty database, pull any of those files into
  // the normalized tables so existing progress carries over. Runs once: after the
  // import the tables are no longer empty, so subsequent startups skip it.
  private async importLegacyFilesIfEmpty(): Promise<void> {
    try {
      const chunkCount = await this.chunkRepo.count();
      const shipCount = await this.shipRepo.count();
      if (chunkCount > 0 || shipCount > 0) return;

      if (existsSync(LEGACY_WORLD_FILE)) {
        const world = this.normalizeWorld(
          JSON.parse(readFileSync(LEGACY_WORLD_FILE, 'utf8')) as World,
        );
        await this.chunkRepo.save(
          world.chunks.map((c) => this.chunkRepo.create(c)),
        );
        await this.portRepo.save(world.ports.map((p) => this.portToEntity(p)));
        this.logger.log('Imported legacy world.json into the database');
      }

      if (existsSync(LEGACY_PLAYERS_DIR)) {
        const files = readdirSync(LEGACY_PLAYERS_DIR).filter((f) =>
          f.endsWith('.json'),
        );
        for (const file of files) {
          const userId = file.replace(/\.json$/, '');
          const player = this.normalizePlayer(
            JSON.parse(
              readFileSync(join(LEGACY_PLAYERS_DIR, file), 'utf8'),
            ) as Player,
          );
          const entity = this.newShipEntity(userId, player);
          for (const inv of entity.inventory) {
            inv.quantity = player.ship.cargo[inv.resource as Resource] ?? 0;
          }
          for (const pr of entity.purchases) {
            const stat = player.purchases.perResource[pr.resource as Resource];
            pr.spent = stat?.spent ?? 0;
            pr.quantity = stat?.quantity ?? 0;
          }
          await this.shipRepo.save(entity);
        }
        if (files.length > 0) {
          this.logger.log(
            `Imported ${files.length} legacy player file(s) into the database`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`Legacy file import skipped: ${String(err)}`);
    }
  }
}
