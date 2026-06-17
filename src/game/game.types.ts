// Shared game-domain types and constants for the trading-ship game.

// The five tradeable goods. Keep this list as the single source of truth.
export const RESOURCES = ['wood', 'grain', 'iron', 'spice', 'cloth'] as const;
export type Resource = (typeof RESOURCES)[number];

export type Inventory = Record<Resource, number>;

export interface Ship {
  x: number;
  y: number;
  gold: number;
  cargo: Inventory;
  cargoCapacity: number;
}

export interface Port {
  id: string;
  name: string;
  x: number;
  y: number;
  // Base price per resource at this port. Buy/sell spreads are derived from it.
  prices: Record<Resource, number>;
}

// Cumulative record of money spent buying goods, so the game can show the
// player how much they have invested and their average unit cost per good.
export interface PurchaseStats {
  totalSpent: number;
  perResource: Record<Resource, { spent: number; qty: number }>;
}

export interface GameState {
  world: { width: number; height: number };
  ship: Ship;
  ports: Port[];
  purchases: PurchaseStats;
}

// Buy price (port -> player) and sell price (player -> port) derived from a
// port's base price. The spread is what makes the port profitable to operate
// and gives the player room to arbitrage between ports.
export const BUY_MARKUP = 1.15;
export const SELL_MARKDOWN = 0.85;

export function buyPrice(base: number): number {
  return Math.ceil(base * BUY_MARKUP);
}

export function sellPrice(base: number): number {
  return Math.floor(base * SELL_MARKDOWN);
}

// How close (world units) the ship must be to a port to trade with it.
export const DOCK_RADIUS = 60;

export function emptyInventory(): Inventory {
  return { wood: 0, grain: 0, iron: 0, spice: 0, cloth: 0 };
}

export function emptyPurchases(): PurchaseStats {
  return {
    totalSpent: 0,
    perResource: {
      wood: { spent: 0, qty: 0 },
      grain: { spent: 0, qty: 0 },
      iron: { spent: 0, qty: 0 },
      spice: { spent: 0, qty: 0 },
      cloth: { spent: 0, qty: 0 },
    },
  };
}
