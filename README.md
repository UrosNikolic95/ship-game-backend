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

State is persisted to `game-state.json` in the working directory, so the world
and your progress survive restarts. The loader migrates older save formats
forward.

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
  app.module.ts          root module
  game/
    game.controller.ts   HTTP routes under /game
    game.service.ts      economy rules, world generation, persistence
    game.types.ts        shared domain types, constants, world-gen helpers
```

## Setup

```bash
npm install
```

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
