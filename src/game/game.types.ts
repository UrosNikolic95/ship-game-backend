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
  // Which hull the player is sailing; drives cargo capacity. See BOATS.
  boatId: string;
}

export interface Port {
  id: string;
  name: string;
  x: number;
  y: number;
  // Base price per resource at this port. Buy/sell spreads are derived from it.
  prices: Record<Resource, number>;
  // Hulls this port's shipyard sells. Empty when the port has no shipyard.
  boatIds: string[];
}

// A buyable hull. Larger hulls carry more cargo but cost more gold.
export interface Boat {
  id: string;
  name: string;
  cargoCapacity: number;
  // Sticker price of the hull. Upgrades cost the difference between hulls,
  // since the old hull is traded in at full value (see GameService.buyShip).
  price: number;
}

// Buyable hulls, smallest to largest. The sloop is the starting boat and is
// never sold (price 0).
export const BOATS: Boat[] = [
  { id: 'sloop', name: 'Sloop', cargoCapacity: 50, price: 0 },
  { id: 'cutter', name: 'Cutter', cargoCapacity: 120, price: 1500 },
  { id: 'trader', name: 'Trader', cargoCapacity: 250, price: 4500 },
  { id: 'galleon', name: 'Galleon', cargoCapacity: 500, price: 12000 },
];

export function findBoat(id: string): Boat | undefined {
  return BOATS.find((b) => b.id === id);
}

// Which hulls each port's shipyard sells, keyed by port id. Bigger trading hubs
// offer better boats — only Sunreach's yard builds the galleon, and Mistbay has
// no shipyard at all, so where you upgrade matters.
export const PORT_SHIPYARDS: Record<string, string[]> = {
  harbor: ['cutter'],
  saltmoor: ['cutter', 'trader'],
  ironcliff: ['cutter'],
  greenport: ['trader'],
  sunreach: ['trader', 'galleon'],
  mistbay: [],
};

// Cumulative record of money spent buying goods, so the game can show the
// player how much they have invested and their average unit cost per good.
export interface PurchaseStats {
  totalSpent: number;
  perResource: Record<Resource, { spent: number; quantity: number }>;
}

// One generated square of the infinite world. A chunk (cx, cy) covers the world
// region [cx*CHUNK_SIZE, (cx+1)*CHUNK_SIZE) x [cy*CHUNK_SIZE, (cy+1)*CHUNK_SIZE).
export interface ChunkCoord {
  cx: number;
  cy: number;
}

export interface GameState {
  // World units per chunk. The world is an unbounded grid of these squares.
  chunkSize: number;
  // World seed; chunk content is generated deterministically from it.
  seed: number;
  // Chunks generated so far. Chunk (0,0) is the hand-made starting world; the
  // rest are procedurally generated as the ship sails into them.
  chunks: ChunkCoord[];
  ship: Ship;
  // All ports across every generated chunk, in absolute world coordinates.
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
      wood: { spent: 0, quantity: 0 },
      grain: { spent: 0, quantity: 0 },
      iron: { spent: 0, quantity: 0 },
      spice: { spent: 0, quantity: 0 },
      cloth: { spent: 0, quantity: 0 },
    },
  };
}

// ---- chunked world generation -----------------------------------------------

// Side length (world units) of a chunk. Matches the original fixed world so the
// hand-made starting area fits exactly inside chunk (0,0).
export const CHUNK_SIZE = 4000;

// Generated ports are kept this far from chunk edges so they never straddle a
// seam and so two ports in neighbouring chunks don't end up on top of each other.
export const PORT_MARGIN = 400;

// Which chunk a world coordinate falls in (works for negative coordinates).
export function chunkOf(v: number): number {
  return Math.floor(v / CHUNK_SIZE);
}

// Deterministic PRNG: same seed always yields the same stream. Returns a
// function producing floats in [0, 1).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mix the world seed with a chunk's coordinates into a single 32-bit seed, so
// every chunk generates identical content every time it's (re)created.
export function hashChunk(seed: number, cx: number, cy: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (cx >>> 0), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (cy >>> 0), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// Syllables stitched into procedural port names.
const NAME_PREFIXES = [
  'Black', 'Storm', 'Gull', 'Wind', 'Tide', 'Coral', 'Drift', 'Frost',
  'Amber', 'Dusk', 'Reef', 'Pearl', 'Shoal', 'Bramble', 'Hollow', 'Thorn',
];
const NAME_SUFFIXES = [
  'haven', 'reach', 'port', 'bay', 'wick', 'crest', 'fall', 'moor',
  'cove', 'gate', 'watch', 'hollow', 'point', 'shore', 'landing', 'keep',
];

// Build a port name from the RNG. Coordinates are appended only on collision by
// the caller; here we just produce a plausible name.
export function generatePortName(rng: () => number): string {
  const p = NAME_PREFIXES[Math.floor(rng() * NAME_PREFIXES.length)];
  const s = NAME_SUFFIXES[Math.floor(rng() * NAME_SUFFIXES.length)];
  return `${p}${s}`;
}

// A randomized base-price profile in the same magnitude as the hand-made ports
// (roughly 5..40 per good), so generated ports stay tradeable against them.
export function generatePrices(rng: () => number): Record<Resource, number> {
  const prices = {} as Record<Resource, number>;
  for (const r of RESOURCES) {
    prices[r] = 5 + Math.floor(rng() * 36); // 5..40
  }
  return prices;
}
