# Triphoria — Hotel Offer Orchestrator

Aggregates hotel offers from two (mock) suppliers, de-duplicates hotels by name, keeps the **best-priced offer per hotel**, stores the result in **Redis** and filters it by price **inside Redis**. A **Temporal** workflow runs the supplier calls in parallel, with retries.

**Stack:** Node.js 22 · TypeScript · Express 5 · Temporal · Redis · Docker Compose

- Design docs: [`docs/PRD.md`](docs/PRD.md) (product) and [`docs/TRD.md`](docs/TRD.md) (technical)
- Postman collection: [`postman/Triphoria.postman_collection.json`](postman/Triphoria.postman_collection.json)

---

## Quick start (Docker)

Requires Docker with Compose v2.

```bash
git clone <this-repo> triphoria && cd triphoria
docker compose up --build
```

| Service | URL |
|---|---|
| API | http://localhost:3000 |
| Temporal Web UI | http://localhost:8233 |
| Redis | localhost:6379 |

**Port already in use?** (`Bind for 0.0.0.0:3000 failed: port is already allocated`) Pick other host ports in a `.env` file next to `docker-compose.yml`, for example `API_PORT=3001`. `REDIS_PORT`, `TEMPORAL_PORT` and `TEMPORAL_UI_PORT` work the same way. Inside the stack the containers still talk on the default ports. In Postman, set `baseUrl` to match (for example `http://localhost:3001`).

Try it:

```bash
curl "http://localhost:3000/api/hotels?city=delhi"
curl "http://localhost:3000/api/hotels?city=delhi&minPrice=5000&maxPrice=9500"
curl "http://localhost:3000/health"
```

Every `/api/hotels` call that runs the workflow shows up in the Temporal UI under **Workflows** (`hotel-offers-<city>-<uuid>`). There you can see the two supplier activities running in parallel, plus the `cacheHotels` activity.

Stop with `Ctrl+C`, then `docker compose down`.

---

## API

### `GET /api/hotels?city=<city>`

Runs the Temporal workflow:

1. Calls **Supplier A** and **Supplier B** in parallel.
2. De-duplicates hotels by name. When both suppliers list a hotel, the **cheaper** offer wins; a hotel listed by only one supplier is kept as is.
3. Saves the de-duplicated list in Redis.
4. Returns it, sorted by price.

```json
[
  { "name": "Lemon Tree", "price": 4200,  "supplier": "Supplier A", "commissionPct": 8 },
  { "name": "Holtin",     "price": 5340,  "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison",    "price": 5900,  "supplier": "Supplier A", "commissionPct": 13 },
  { "name": "Taj Palace", "price": 9500,  "supplier": "Supplier B", "commissionPct": 18 },
  { "name": "ITC Maurya", "price": 11000, "supplier": "Supplier B", "commissionPct": 14 }
]
```

### `GET /api/hotels?city=<city>&minPrice=<min>&maxPrice=<max>`

Filters the stored list **in Redis** (`ZRANGE hotels:<city> <min> <max> BYSCORE`). Bounds are inclusive and either one can be left out. If the city is not cached yet (or the cache has expired), the workflow runs first. The `X-Cache: HIT|MISS` response header shows which happened.

### `GET /health`

Reports **Supplier A** and **Supplier B** separately (each is checked over HTTP), plus Redis and Temporal. Returns `200` when everything is up, `503` otherwise.

```json
{
  "status": "ok",
  "suppliers": { "supplierA": { "status": "up", "latencyMs": 3 }, "supplierB": { "status": "up", "latencyMs": 2 } },
  "dependencies": { "redis": { "status": "up", "latencyMs": 1 }, "temporal": { "status": "up", "latencyMs": 4 } }
}
```

### Mock suppliers

| Endpoint | Description |
|---|---|
| `GET /supplierA/hotels?city=delhi` | Supplier A's hotels (`hotelId`, `name`, `price`, `city`, `commissionPct`) |
| `GET /supplierB/hotels?city=delhi` | Supplier B's hotels |
| `POST /supplierA/status` `{"up": false}` | Simulate an outage: the supplier returns `503` until set back to `{"up": true}` |
| `POST /supplierB/status` `{"up": false}` | Same for Supplier B |

You can also start a supplier in the down state with `SUPPLIER_A_DOWN=true` / `SUPPLIER_B_DOWN=true`.

Mock data: **delhi** has overlaps where A wins (Radison), B wins (Holtin) and an equal-price tie (Taj Palace), plus hotels only one supplier lists. **mumbai** overlaps partly. **goa** is Supplier A only. Any other city returns `[]`.

### Status codes

| Case | Status |
|---|---|
| Success (including `[]`) | `200` |
| One supplier failed | `200` with the other supplier's hotels and header `X-Degraded-Suppliers: Supplier B` |
| Missing or invalid `city`, bad `minPrice`/`maxPrice`, `minPrice > maxPrice` | `400` |
| Both suppliers failed | `502` |
| Redis or Temporal unavailable, or workflow timeout | `503` |

Every response carries an `X-Request-Id` header, which also appears in the API and worker logs.

---

## Design decisions and assumptions

The brief leaves these open. They are also listed in [`docs/PRD.md`](docs/PRD.md#5-business-rules-and-assumptions).

- **Dedupe key:** hotel name, trimmed and case-insensitive (`"Holtin"` = `" HOLTIN "`). No fuzzy matching.
- **Equal prices:** the higher `commissionPct` wins; if that is also equal, Supplier A wins. The result is the same on every run.
- **City:** case-insensitive and trimmed.
- **Partial failure:** if one supplier fails after its retries, the API returns the other supplier's hotels and flags it in `X-Degraded-Suppliers`. The body stays a plain array, as the brief specifies.
- **Caching:** an unfiltered request always runs the workflow and refreshes Redis (TTL 300 s). A filtered request reads Redis and only runs the workflow on a cache miss. Partial results are cached for 30 s only, so a recovered supplier shows up quickly.

### Temporal

- Workflow `hotelOffersWorkflow` on task queue `hotel-offers`.
- `fetchSupplierHotels` activity: 5 s start-to-close timeout, 3 attempts with exponential backoff. 5xx, network errors and timeouts are retried. 4xx responses and malformed payloads fail at once (non-retryable).
- `cacheHotels` activity: up to 5 attempts.
- The orchestration logic (`src/temporal/orchestrate.ts`) and the merge (`src/domain/merge.ts`) are pure functions, so they are deterministic inside the workflow sandbox and easy to unit-test.

### Redis layout (per city, all keys expire together)

| Key | Type | Content |
|---|---|---|
| `hotels:<city>` | Sorted set | member = hotel name, score = price |
| `hotels:<city>:offers` | Hash | hotel name → offer JSON |
| `hotels:<city>:meta` | Hash | `fetchedAt`, `count`, `degraded`: marks the city as cached, even when it has no hotels |

Writes are atomic (`MULTI`/`EXEC`). The filter is one Lua script that checks the city is cached, runs `ZRANGE … BYSCORE`, then `HMGET`s the offers, so a key expiring mid-read cannot return a partial result.

Inspect it yourself:

```bash
docker compose exec redis redis-cli ZRANGE hotels:delhi 5000 9500 BYSCORE WITHSCORES
```

---

## Postman

Import `postman/Triphoria.postman_collection.json` and run it in order (Collection Runner). The `baseUrl` variable defaults to `http://localhost:3000`. It has 28 requests and 70 assertions in six folders:

0. **Setup:** checks `baseUrl` reaches this API, then resets both suppliers to up
1. **Health:** all components up
2. **Mock suppliers:** raw A and B responses; checks the names overlap
3. **Best offers:** delhi dedupe and winners, case-insensitive city, no-results city, 400s
4. **Price filter (Redis):** range, min only, max only (inclusive), no matches, cache miss, 400s
5. **Supplier outage:** B down → partial results and `/health` 503 → both down → 502 → recover

From the command line, with the stack running:

```bash
npm run test:postman        # npx newman run postman/Triphoria.postman_collection.json
```

---

## Running without Docker

Requires Node.js 22+, Redis 6.2+ and a Temporal server ([Temporal CLI](https://docs.temporal.io/cli): `temporal server start-dev`).

```bash
npm ci
cp .env.example .env          # defaults point at localhost
npm run build

temporal server start-dev     # terminal 1 (UI on http://localhost:8233)
redis-server                  # terminal 2
npm start                     # terminal 3 — API on :3000
npm run start:worker          # terminal 4 — Temporal worker
```

For development with reload, use `npm run dev` and `npm run dev:worker`.

## Tests

```bash
npm test             # all tests (unit + integration). Integration tests need Redis on localhost:6379
npm run test:unit    # unit tests only, no external services
npm run typecheck
```

| Suite | Covers |
|---|---|
| `test/unit/merge.test.ts` | Best-offer selection, tie-breaks, name normalisation, mock-data overlaps |
| `test/unit/orchestrate.test.ts` | Parallel fan-out, partial failure, all-failed, cache errors |
| `test/unit/activities.test.ts` | Supplier HTTP mapping, retryable vs non-retryable failures, timeouts, cache TTLs (Temporal `MockActivityEnvironment`) |
| `test/unit/workflow-bundle.test.ts` | The workflow bundles for Temporal's deterministic sandbox |
| `test/unit/suppliers.test.ts` | Mock supplier endpoints and outage switch |
| `test/integration/hotelStore.test.ts` | Redis storage, inclusive/open ranges, empty city, atomic refresh, TTL (real Redis) |
| `test/integration/api.test.ts` | HTTP contract, validation, status codes, headers, `/health` (real Redis) |

`npm run harness` starts the app on :3100 with the real activities, orchestration logic and Redis, but calls them directly instead of through Temporal. It is useful for running the Postman collection when no Temporal server is available:

```bash
npm run harness &
npx -y newman@6 run postman/Triphoria.postman_collection.json --env-var baseUrl=http://localhost:3100
```

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | API port |
| `REDIS_URL` | `redis://localhost:6379` | |
| `TEMPORAL_ADDRESS` | `localhost:7233` | |
| `TEMPORAL_NAMESPACE` | `default` | |
| `TEMPORAL_TASK_QUEUE` | `hotel-offers` | |
| `SUPPLIER_BASE_URL` | `http://localhost:3000` | Where the worker reaches the mock suppliers |
| `SUPPLIER_TIMEOUT_MS` | `3000` | Per supplier HTTP call |
| `CACHE_TTL_SECONDS` | `300` | |
| `DEGRADED_TTL_SECONDS` | `30` | TTL for partial results |
| `WORKFLOW_TIMEOUT_MS` | `15000` | How long the API waits for the workflow |
| `SUPPLIER_A_DOWN` / `SUPPLIER_B_DOWN` | `false` | Start a mock supplier in the down state |
| `LOG_LEVEL` | `info` | |
| `TEMPORAL_CLI_VERSION` | `latest` | Compose only: tag of the `temporalio/temporal` image |

## Deployment

`docker compose up --build -d` runs the whole stack on any Docker host. The API and worker are built from one image (`Dockerfile`, multi-stage, non-root). The API runs `node dist/server.js` and the worker runs `node dist/worker.js`, so they can be deployed and scaled separately. Point them at managed Redis and Temporal (for example Temporal Cloud) with `REDIS_URL` and `TEMPORAL_ADDRESS`.

The Compose file runs Temporal's single-binary **dev server** (`temporalio/temporal server start-dev`). Workflow history is held in memory and lost on restart, which is fine for this assessment. For production, run the Temporal server with a persistent database or use Temporal Cloud.

## Project structure

```
src/
  server.ts, worker.ts      entry points
  app.ts                    Express app (routes + error handling)
  api/                      /api/hotels, /health, errors, request context
  domain/merge.ts           best-offer merge (pure)
  temporal/                 workflow, activities, orchestration core, client, retry policy
  redis/                    client + hotel store (sorted set, hash, Lua filter)
  suppliers/                mock supplier data + routes
test/                       unit, integration, local harness
postman/                    Postman collection
docs/                       PRD + TRD
```
