# Ship Game — Backend

The server for a 2D sailing & trading game. A single player captains a ship
across an unbounded, procedurally generated sea, docks at ports, hauls goods
between markets to profit on the price spread, and upgrades to bigger hulls.
This backend is the authoritative source of the game economy and world; the
[Angular frontend](../frontend) renders it and drives the ship.

Built with [NestJS](https://nestjs.com/) and TypeScript.

## The game in brief

- **World** — an infinite grid of `4000 × 4000` chunks. Chunk `(0, 0)` is a
  hand-made starting area with six ports; every other chunk is generated
  deterministically from a world seed as the ship sails into it, placing 1–3
  ports with randomized names, prices, and (sometimes) a shipyard.
- **Trading** — each port has a base price per good. You buy at a markup
  (`×1.15`) and sell at a markdown (`×0.85`), so profit comes from carrying a
  good from where it is cheap to where it is dear. The ship must be within
  `DOCK_RADIUS` (60 world units) of a port to trade.
- **Goods** — `wood`, `grain`, `iron`, `spice`, `cloth`.
- **Ships** — four hulls (Sloop → Cutter → Trader → Galleon) with increasing
  cargo capacity. You start in the Sloop. Upgrading trades the old hull in at
  full value, so you pay only the price difference, and only at a port whose
  shipyard builds that hull.
- **Cost basis** — purchases are tracked per good so the client can show how
  much gold is tied up in cargo and the average unit cost.

State is persisted to a **PostgreSQL** database (via TypeORM), so the shared
world and each player's progress survive restarts. The schema is normalized:

- `world_chunk` — one row per explored chunk.
- `ports` — one row per port, with per-resource base prices as columns.
- `boat_type` — the hull catalog (Sloop → Galleon); cargo capacity and price per
  hull. Seeded from the `BOATS` constant on first startup.
- `boat_for_sale` — which boat types each port's shipyard sells (a port ↔ boat
  type link table).
- `ship` — one row per player (keyed by the cookie `userId`); the hull it owns is
  a foreign key to `boat_type`, which also determines its cargo capacity.
- `ship_inventory` — a ship's cargo, one row per (ship, resource).
- `purchases` — cost-basis bookkeeping, one row per (ship, resource).

On first run against an empty database, any legacy JSON saves under `data/`
(`world.json` and `players/*.json`, the format used before the move to
PostgreSQL) are imported automatically so existing progress carries over. The
world seed is a fixed constant: every generated chunk and its ports are
persisted, so the world is reconstructed entirely from the database.

## API

All routes are under `/game`. CORS is enabled for the local Angular dev server.

| Method | Path               | Body                                        | Description                                  |
| ------ | ------------------ | ------------------------------------------- | -------------------------------------------- |
| `GET`  | `/game/state`      | —                                           | Current full game state.                     |
| `POST` | `/game/move`       | `{ x, y }`                                  | Persist the ship's position; generates the chunk it enters. |
| `POST` | `/game/trade`      | `{ portId, resource, quantity, action }`    | Buy or sell a good at a docked port.         |
| `POST` | `/game/buy-ship`   | `{ portId, boatId }`                        | Upgrade to a larger hull at a port's shipyard. |
| `POST` | `/game/reset`      | —                                           | Start a fresh world.                         |

`action` is `'buy' | 'sell'`. Invalid trades (not docked, not enough gold/cargo/
goods, unknown port/resource) return `400`.

## Project layout

```
src/
  main.ts                bootstrap; enables CORS, listens on PORT (default 3000)
  app.module.ts          root module; loads .env and the TypeORM/PostgreSQL connection
  game/
    game.controller.ts   HTTP routes under /game
    game.service.ts      economy rules, world generation, persistence
    game.types.ts        shared domain types, constants, world-gen helpers
    entities/
      world-chunk.entity.ts      an explored chunk of the world
      port.entity.ts             a port and its per-resource prices
      boat-type.entity.ts        the hull catalog (capacity, price)
      boat-for-sale.entity.ts    hulls a port's shipyard sells (port ↔ boat type)
      ship.entity.ts             a player's ship (owns a boat type)
      ship-inventory.entity.ts   a ship's cargo (per resource)
      purchase.entity.ts         cost-basis bookkeeping (per resource)
```

## Setup

```bash
npm install
```

This backend stores game data in PostgreSQL. Provide a database and copy the
example environment file, then fill in your connection details:

```bash
cp .env.example .env
```

`.env` holds the connection settings (it is gitignored):

| Variable         | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `DB_HOST`        | PostgreSQL host (e.g. `localhost`).                      |
| `DB_PORT`        | PostgreSQL port (default `5432`).                        |
| `DB_USER`        | Database user.                                           |
| `DB_PASSWORD`    | Database password.                                       |
| `DB_NAME`        | Database name.                                           |
| `DB_SYNCHRONIZE` | `true` to auto-create/update tables on startup (dev).    |

With `DB_SYNCHRONIZE=true` the `world` and `players` tables are created
automatically the first time the server starts, so no manual migration is
needed for local development.

## Run

```bash
# watch mode (recommended for development)
npm run start:dev

# one-off
npm run start

# production (after `npm run build`)
npm run start:prod
```

The server listens on `http://localhost:3000` (override with the `PORT`
environment variable).

## Tests

```bash
npm run test       # unit tests
npm run test:e2e   # end-to-end tests
npm run test:cov   # coverage
```

## Lint & format

```bash
npm run lint
npm run format
```
