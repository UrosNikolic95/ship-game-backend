import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  GameState,
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

// State is persisted here so the game "remembers" itself across restarts.
const SAVE_FILE = join(process.cwd(), 'game-state.json');

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);
  private state: GameState;

  constructor() {
    this.state = this.load() ?? this.createWorld();
    this.save();
  }

  getState(): GameState {
    return this.state;
  }

  // The player drives the ship client-side; we just persist where it ended up.
  // The world is unbounded, so there's no clamp — but we make sure the chunk the
  // ship now sits in exists (the client also requests this as it crosses edges).
  moveShip(x: number, y: number): GameState {
    this.state.ship.x = x;
    this.state.ship.y = y;
    this.ensureChunk(chunkOf(x), chunkOf(y));
    this.save();
    return this.state;
  }

  trade(
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

    const port = this.state.ports.find((p) => p.id === portId);
    if (!port) throw new BadRequestException(`Unknown port: ${portId}`);

    const ship = this.state.ship;
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
      if (this.cargoUsed() + quantity > ship.cargoCapacity) {
        throw new BadRequestException('Not enough cargo space');
      }
      ship.gold -= cost;
      ship.cargo[resource] += quantity;

      // Add the outlay to this resource's cost basis (money tied up in cargo).
      const stat = this.state.purchases.perResource[resource];
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
      const stat = this.state.purchases.perResource[resource];
      const avg = stat.quantity > 0 ? stat.spent / stat.quantity : 0;
      stat.quantity -= quantity;
      stat.spent -= avg * quantity;
      if (stat.quantity <= 0) {
        stat.quantity = 0;
        stat.spent = 0;
      }
    }

    // Total spent reflects the cost basis of everything still in the hold.
    this.state.purchases.totalSpent = RESOURCES.reduce(
      (sum, r) => sum + this.state.purchases.perResource[r].spent,
      0,
    );

    this.save();
    return this.state;
  }

  // Upgrade the ship to a larger hull sold by the docked port's shipyard. The
  // old hull is traded in at full value, so the player pays only the difference.
  buyShip(portId: string, boatId: string): GameState {
    const port = this.state.ports.find((p) => p.id === portId);
    if (!port) throw new BadRequestException(`Unknown port: ${portId}`);

    const ship = this.state.ship;
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
    this.save();
    return this.state;
  }

  reset(): GameState {
    this.state = this.createWorld();
    this.save();
    return this.state;
  }

  private cargoUsed(): number {
    return RESOURCES.reduce((sum, r) => sum + this.state.ship.cargo[r], 0);
  }

  // ---- world generation ----------------------------------------------------

  private createWorld(): GameState {
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
      ship: {
        x: 850,
        y: 850,
        gold: 500,
        cargo: emptyInventory(),
        cargoCapacity: 50,
        boatId: 'sloop',
      },
      ports,
      purchases: emptyPurchases(),
    };
  }

  // ---- chunk generation -----------------------------------------------------

  // Generate the chunk at (cx, cy) if it doesn't exist yet, appending its ports
  // to the flat port list. Idempotent: re-requesting a chunk is a no-op.
  ensureChunk(cx: number, cy: number): GameState {
    if (this.state.chunks.some((c) => c.cx === cx && c.cy === cy)) {
      return this.state;
    }
    const ports = this.generateChunk(cx, cy);
    this.state.ports.push(...ports);
    this.state.chunks.push({ cx, cy });
    this.save();
    return this.state;
  }

  // Procedurally place 1–3 ports inside a chunk, seeded so the same chunk always
  // produces the same ports. Chunk (0,0) is hand-made and never generated here.
  private generateChunk(cx: number, cy: number): Port[] {
    const rng = mulberry32(hashChunk(this.state.seed, cx, cy));
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

  private save(): void {
    try {
      writeFileSync(SAVE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.logger.error(`Failed to save game state: ${String(err)}`);
    }
  }

  private load(): GameState | null {
    try {
      if (!existsSync(SAVE_FILE)) return null;
      const parsed = JSON.parse(readFileSync(SAVE_FILE, 'utf8')) as GameState &
        { world?: { width: number; height: number } };
      // Saves written before the chunked world lack these fields: the old fixed
      // 4000x4000 world becomes chunk (0,0) and we mint a fresh seed for the rest.
      if (!parsed.chunkSize) parsed.chunkSize = CHUNK_SIZE;
      if (parsed.seed == null) parsed.seed = Math.floor(Math.random() * 0xffffffff);
      if (!parsed.chunks) parsed.chunks = [{ cx: 0, cy: 0 }];
      delete parsed.world;
      // Saves written before purchase tracking existed lack this field.
      if (!parsed.purchases) parsed.purchases = emptyPurchases();
      // Saves written before shipyards existed lack the boat fields.
      if (!parsed.ship.boatId) parsed.ship.boatId = 'sloop';
      for (const port of parsed.ports) {
        if (!port.boatIds) port.boatIds = PORT_SHIPYARDS[port.id] ?? [];
      }
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
      this.logger.log('Loaded saved game state');
      return parsed;
    } catch (err) {
      this.logger.warn(`Could not load saved state, starting fresh: ${String(err)}`);
      return null;
    }
  }
}
