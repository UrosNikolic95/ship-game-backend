import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  GameState,
  World,
  Player,
  Port,
  Resource,
  RESOURCES,
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

// Everyone shares one world, persisted here. Each player's private progress
// (ship, gold, cargo, purchases) is persisted to its own file under players/.
const SAVE_DIR = join(process.cwd(), 'data');
const WORLD_FILE = join(SAVE_DIR, 'world.json');
const PLAYERS_DIR = join(SAVE_DIR, 'players');

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);
  // The single world all players sail in.
  private world: World;
  // One player record per user, keyed by the user id carried in their cookie.
  private readonly players = new Map<string, Player>();

  constructor() {
    mkdirSync(PLAYERS_DIR, { recursive: true });
    this.world = this.loadWorld() ?? this.createWorld();
    this.saveWorld();
  }

  // Make sure a player record exists for this user: load their saved file, or
  // start a fresh player at the world's spawn. Called before every request.
  ensureUser(userId: string): void {
    if (this.players.has(userId)) return;
    const player = this.loadPlayer(userId) ?? this.createPlayer();
    this.players.set(userId, player);
    this.savePlayer(userId);
  }

  getState(userId: string): GameState {
    return this.viewFor(userId);
  }

  // The player drives the ship client-side; we just persist where it ended up.
  // The world is unbounded, so there's no clamp — but we make sure the chunk the
  // ship now sits in exists (the client also requests this as it crosses edges).
  moveShip(userId: string, x: number, y: number): GameState {
    const player = this.playerOf(userId);
    player.ship.x = x;
    player.ship.y = y;
    this.ensureChunk(chunkOf(x), chunkOf(y));
    this.savePlayer(userId);
    return this.viewFor(userId);
  }

  trade(
    userId: string,
    portId: string,
    resource: Resource,
    quantity: number,
    action: 'buy' | 'sell',
  ): GameState {
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

    this.savePlayer(userId);
    return this.viewFor(userId);
  }

  // Upgrade the ship to a larger hull sold by the docked port's shipyard. The
  // old hull is traded in at full value, so the player pays only the difference.
  buyShip(userId: string, portId: string, boatId: string): GameState {
    const player = this.playerOf(userId);
    const port = this.world.ports.find((p) => p.id === portId);
    if (!port) throw new BadRequestException(`Unknown port: ${portId}`);

    const ship = player.ship;
    const dist = Math.hypot(ship.x - port.x, ship.y - port.y);
    if (dist > DOCK_RADIUS) {
      throw new BadRequestException('Ship is not docked at this port');
    }
    if (!port.boatIds.includes(boatId)) {
      throw new BadRequestException("This port's shipyard does not sell that boat");
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
    this.savePlayer(userId);
    return this.viewFor(userId);
  }

  // Reset only this player back to a fresh start. The shared world (map, ports,
  // explored chunks) is untouched, so one player resetting doesn't wipe the
  // world out from under everyone else.
  reset(userId: string): GameState {
    this.players.set(userId, this.createPlayer());
    this.savePlayer(userId);
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
        wood: 8, grain: 6, iron: 22, spice: 40, cloth: 18,
      }),
      this.port('saltmoor', 'Saltmoor', 3100, 900, {
        wood: 14, grain: 5, iron: 30, spice: 18, cloth: 12,
      }),
      this.port('ironcliff', 'Ironcliff', 1900, 1700, {
        wood: 20, grain: 12, iron: 9, spice: 33, cloth: 26,
      }),
      this.port('greenport', 'Greenport', 800, 3100, {
        wood: 7, grain: 14, iron: 26, spice: 28, cloth: 9,
      }),
      this.port('sunreach', 'Sunreach', 3300, 3200, {
        wood: 16, grain: 9, iron: 19, spice: 7, cloth: 30,
      }),
      this.port('mistbay', 'Mistbay', 2200, 2600, {
        wood: 11, grain: 8, iron: 15, spice: 24, cloth: 21,
      }),
    ];

    return {
      chunkSize: CHUNK_SIZE,
      seed: Math.floor(Math.random() * 0xffffffff),
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
  ensureChunk(cx: number, cy: number): void {
    if (this.world.chunks.some((c) => c.cx === cx && c.cy === cy)) {
      return;
    }
    const ports = this.generateChunk(cx, cy);
    this.world.ports.push(...ports);
    this.world.chunks.push({ cx, cy });
    this.saveWorld();
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
      if (rng() < 0.25) boatIds = rng() < 0.4 ? ['cutter', 'trader'] : ['cutter'];

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

  // ---- persistence ----------------------------------------------------------

  // Per-user save file. The user id comes from a validated cookie (see the
  // controller), so it is safe to use directly as a file name.
  private playerFile(userId: string): string {
    return join(PLAYERS_DIR, `${userId}.json`);
  }

  private saveWorld(): void {
    try {
      writeFileSync(WORLD_FILE, JSON.stringify(this.world, null, 2));
    } catch (err) {
      this.logger.error(`Failed to save world: ${String(err)}`);
    }
  }

  private savePlayer(userId: string): void {
    const player = this.players.get(userId);
    if (!player) return;
    try {
      writeFileSync(this.playerFile(userId), JSON.stringify(player, null, 2));
    } catch (err) {
      this.logger.error(`Failed to save player ${userId}: ${String(err)}`);
    }
  }

  private loadWorld(): World | null {
    try {
      if (!existsSync(WORLD_FILE)) return null;
      const parsed = JSON.parse(readFileSync(WORLD_FILE, 'utf8')) as World;
      if (!parsed.chunkSize) parsed.chunkSize = CHUNK_SIZE;
      if (parsed.seed == null) parsed.seed = Math.floor(Math.random() * 0xffffffff);
      if (!parsed.chunks) parsed.chunks = [{ cx: 0, cy: 0 }];
      // Saves written before shipyards existed lack the boat fields.
      for (const port of parsed.ports) {
        if (!port.boatIds) port.boatIds = PORT_SHIPYARDS[port.id] ?? [];
      }
      this.logger.log('Loaded shared world');
      return parsed;
    } catch (err) {
      this.logger.warn(`Could not load world, starting fresh: ${String(err)}`);
      return null;
    }
  }

  private loadPlayer(userId: string): Player | null {
    const file = this.playerFile(userId);
    try {
      if (!existsSync(file)) return null;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Player;
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
      this.logger.log(`Loaded player ${userId}`);
      return parsed;
    } catch (err) {
      this.logger.warn(
        `Could not load player ${userId}, starting fresh: ${String(err)}`,
      );
      return null;
    }
  }
}
