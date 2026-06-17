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
  DOCK_RADIUS,
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
  moveShip(x: number, y: number): GameState {
    const { width, height } = this.state.world;
    this.state.ship.x = clamp(x, 0, width);
    this.state.ship.y = clamp(y, 0, height);
    this.save();
    return this.state;
  }

  trade(
    portId: string,
    resource: Resource,
    qty: number,
    action: 'buy' | 'sell',
  ): GameState {
    if (!RESOURCES.includes(resource)) {
      throw new BadRequestException(`Unknown resource: ${resource}`);
    }
    if (!Number.isInteger(qty) || qty <= 0) {
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
      const cost = unit * qty;
      if (cost > ship.gold) {
        throw new BadRequestException('Not enough gold');
      }
      if (this.cargoUsed() + qty > ship.cargoCapacity) {
        throw new BadRequestException('Not enough cargo space');
      }
      ship.gold -= cost;
      ship.cargo[resource] += qty;

      // Add the outlay to this resource's cost basis (money tied up in cargo).
      const stat = this.state.purchases.perResource[resource];
      stat.spent += cost;
      stat.qty += qty;
    } else {
      if (ship.cargo[resource] < qty) {
        throw new BadRequestException('Not enough goods to sell');
      }
      const unit = sellPrice(base);
      ship.gold += unit * qty;
      ship.cargo[resource] -= qty;

      // Release the average *buy* cost of the units sold from the cost basis,
      // not the sale price. Selling everything zeroes the basis (avg -> 0).
      const stat = this.state.purchases.perResource[resource];
      const avg = stat.qty > 0 ? stat.spent / stat.qty : 0;
      stat.qty -= qty;
      stat.spent -= avg * qty;
      if (stat.qty <= 0) {
        stat.qty = 0;
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
    const world = { width: 4000, height: 4000 };

    // Hand-placed ports with distinct price profiles so that hauling a good
    // from where it is cheap to where it is dear is always worthwhile.
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
      world,
      ship: {
        x: 850,
        y: 850,
        gold: 500,
        cargo: emptyInventory(),
        cargoCapacity: 50,
      },
      ports,
      purchases: emptyPurchases(),
    };
  }

  private port(
    id: string,
    name: string,
    x: number,
    y: number,
    prices: Record<Resource, number>,
  ): Port {
    return { id, name, x, y, prices };
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
      const parsed = JSON.parse(readFileSync(SAVE_FILE, 'utf8')) as GameState;
      // Saves written before purchase tracking existed lack this field.
      if (!parsed.purchases) parsed.purchases = emptyPurchases();
      this.logger.log('Loaded saved game state');
      return parsed;
    } catch (err) {
      this.logger.warn(`Could not load saved state, starting fresh: ${String(err)}`);
      return null;
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
