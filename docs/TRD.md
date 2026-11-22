# TRD — Hotel Offer Orchestrator (Triphoria)

| | |
|---|---|
| **Status** | v1.1 (updated to match the implementation) |
| **Date** | 2026-11-21 |
| **Related** | [PRD.md](./PRD.md) |

---

## 1. Architecture

```
                 ┌──────────────────────────── docker compose ────────────────────────────┐
                 │                                                                        │
  Client ──HTTP──▶  api (Express)                                                         │
  / Postman      │   ├─ GET /api/hotels ──start workflow──▶ Temporal Server ◀──poll── worker
                 │   ├─ GET /health, /livez                  (dev server + Web UI)    │    │
                 │   ├─ GET /supplierA/hotels  ◀──────────── HTTP ────────────────────┤    │
                 │   ├─ GET /supplierB/hotels  ◀──────────── HTTP ────────────────────┤    │
                 │   └─ ZRANGE BYSCORE ──▶ Redis ◀──── MULTI write (cacheHotels) ─────┘    │
                 └────────────────────────────────────────────────────────────────────────┘
```

Two Node processes are built from **one image**:

| Process | Entry point | Job |
|---|---|---|
| `api` | `dist/server.js` | HTTP layer: validation, starting workflows, Redis filter reads, mock suppliers, health. |
| `worker` | `dist/worker.js` | Runs the Temporal workflow and activities on task queue `hotel-offers`. |

The mock suppliers live in the `api` process, as the brief asks ("within your service"). Activities reach them over real HTTP (`SUPPLIER_BASE_URL=http://api:3000`). This keeps the supplier boundary realistic: timeouts, 503s and retries all behave as they would with a real supplier.

### Request flow — `GET /api/hotels?city=delhi`

1. Validate the query (zod). Normalise `city` (trim, lowercase).
2. **No price filter:** start `hotelOffersWorkflow({ city })` and wait for its result.
3. Workflow:
   1. Runs `fetchSupplierHotels('A', city)` and `fetchSupplierHotels('B', city)` in parallel (`Promise.allSettled`).
   2. If both fail → throws `ApplicationFailure` `ALL_SUPPLIERS_FAILED` (non-retryable).
   3. `mergeBestOffers(a, b)`: a pure, deterministic function that runs in the workflow.
   4. Runs `cacheHotels(city, offers)`, which writes to Redis atomically.
   5. Returns `{ hotels, degradedSuppliers }`.
4. The API sets `X-Degraded-Suppliers` if needed and returns `hotels` (a plain array).

### Request flow — with `minPrice` / `maxPrice`

1. Validate the bounds.
2. Run the filter Lua script in Redis (§7). It returns `nil` when `hotels:{city}:meta` is missing.
   - **Missing or expired:** run the workflow as above (fills Redis), then run the script again.
3. Inside the script: `ZRANGE hotels:{city} <min> <max> BYSCORE` → names, then `HMGET hotels:{city}:offers …names` → offers.
4. Return them in price order.

So filtering always runs inside Redis, as required. The workflow only runs when the cache is cold.

## 2. Tech choices

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node 22 LTS, TypeScript (strict, `nodenext`, CommonJS output) | Built with `tsc` to `dist/`. Node 20 reached end of life in April 2026. |
| HTTP | Express 5 | Async handler errors reach the error middleware natively. |
| Validation | zod | Query params and supplier responses. |
| Orchestration | `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity` | |
| Redis client | ioredis | Supports MULTI and `zrange … BYSCORE`. |
| Logging | pino (API); Temporal's `log` in workflows and activities, sent to the same pino logger through the worker's `Runtime` logger | One JSON log format everywhere. Activity logging falls back to pino when called outside a worker. |
| Tests | vitest + supertest; `@temporalio/testing` `MockActivityEnvironment` for activities; `bundleWorkflowCode` for sandbox checks; newman for the collection | |
| Supplier HTTP | Built-in `fetch` with `AbortSignal.timeout` | No extra dependency. |

## 3. Project structure

```
Triphoria/
├─ docs/                 PRD.md, TRD.md
├─ src/
│  ├─ config.ts          env parsing (zod) → typed config
│  ├─ logger.ts          pino instance
│  ├─ types.ts           SupplierHotel, HotelOffer, SupplierId
│  ├─ app.ts             Express app factory (dependency-injected, used by tests)
│  ├─ domain/
│  │  └─ merge.ts        mergeBestOffers()  ← pure, unit-tested, workflow-safe
│  ├─ suppliers/
│  │  ├─ data.ts         static mock data for A and B
│  │  └─ router.ts       /supplierA, /supplierB, status toggle
│  ├─ redis/
│  │  ├─ client.ts
│  │  └─ hotelStore.ts   saveCity(), filterByPrice() (Lua), ping()
│  ├─ temporal/
│  │  ├─ orchestrate.ts  collectBestOffers()  ← workflow logic, pure, unit-tested
│  │  ├─ workflows.ts    hotelOffersWorkflow (thin wrapper over orchestrate)
│  │  ├─ activities.ts   fetchSupplierHotels, cacheHotels
│  │  ├─ client.ts       lazy Temporal Client + workflow runner + health probe
│  │  ├─ connection.ts   connect-with-retry helper
│  │  └─ constants.ts    workflow name, error types, activity retry policies
│  ├─ api/
│  │  ├─ hotels.ts       GET /api/hotels
│  │  ├─ health.ts       GET /health
│  │  ├─ requestContext.ts  request id + access log
│  │  └─ errors.ts       error types + Express error middleware
│  ├─ server.ts          api entry point
│  └─ worker.ts          worker entry point
├─ test/                 unit, integration, e2e/local-harness.ts
├─ postman/Triphoria.postman_collection.json
├─ Dockerfile
├─ docker-compose.yml
├─ .env.example
└─ README.md
```

`workflows.ts` may import only `temporal/orchestrate.ts`, `domain/merge.ts`, `types.ts`, `constants.ts` and the activity *types*. Temporal's workflow sandbox does not allow Node APIs or I/O there. `test/unit/workflow-bundle.test.ts` enforces this by bundling the workflow with Temporal's bundler.

## 4. Data models

```ts
type SupplierId = 'A' | 'B';

// What a supplier returns
interface SupplierHotel {
  hotelId: string;        // "a1"
  name: string;           // "Holtin"
  price: number;          // 6000  (INR, integer)
  city: string;           // "delhi"
  commissionPct: number;  // 10
}

// What we return / store
interface HotelOffer {
  name: string;
  price: number;
  supplier: 'Supplier A' | 'Supplier B';
  commissionPct: number;
}

interface WorkflowInput  { city: string }
interface WorkflowResult { hotels: HotelOffer[]; degradedSuppliers: SupplierId[] }
```

Supplier responses are checked with zod inside the activity. A malformed response counts as a non-retryable supplier failure.

## 5. Merge algorithm (`mergeBestOffers`)

```
input: offersA[], offersB[]
map = new Map<normalisedName, HotelOffer>()
for each offer in [...offersA, ...offersB]:
    key = offer.name.trim().toLowerCase()
    current = map.get(key)
    if !current or better(offer, current): map.set(key, offer)
return [...map.values()].sort(by price asc, then name asc)

better(x, y) = x.price < y.price
            || (x.price == y.price && x.commissionPct > y.commissionPct)
            || (x.price == y.price && x.commissionPct == y.commissionPct && x.supplier == 'Supplier A' && y.supplier != 'Supplier A')
```

This is O(n log n) and deterministic, so it is safe inside the workflow. It also handles a supplier that lists the same hotel twice.

## 6. Temporal design

The workflow body is `collectBestOffers()` in `orchestrate.ts`. It takes the activity proxies, a logger and an error factory as dependencies, so it can be unit-tested without a Temporal server.

### Workflow `hotelOffersWorkflow`

| Setting | Value |
|---|---|
| Task queue | `hotel-offers` |
| Workflow ID | `hotel-offers-{city}-{uuid}` (one run per request) |
| Execution timeout | 30 s |

```ts
const { fetchSupplierHotels } = proxyActivities<Acts>({
  startToCloseTimeout: '5s',
  retry: { initialInterval: '200ms', backoffCoefficient: 2, maximumInterval: '2s',
           maximumAttempts: 3, nonRetryableErrorTypes: ['INVALID_SUPPLIER_RESPONSE'] },
});
const { cacheHotels } = proxyActivities<Acts>({
  startToCloseTimeout: '5s',
  retry: { maximumAttempts: 5 },
});
```

Notes:

- `Promise.allSettled` on the two supplier activities. A supplier that still fails after its retries is logged with `log.warn` and added to `degradedSuppliers`.
- Worst case with one supplier down: about 3 × 5 s timeouts plus backoff. For a 503 (the simulated outage) each attempt fails fast, so the delay is about 0.6 s. Both values are configurable.
- If both fail: `ApplicationFailure.nonRetryable('All suppliers unavailable', 'ALL_SUPPLIERS_FAILED')`. The API maps this to 502.
- If `cacheHotels` fails after its retries, the workflow fails. The API maps that to 503: the spec says the list must be saved, so we do not hide this.

### Activities

| Activity | Does | Errors |
|---|---|---|
| `fetchSupplierHotels(supplier, city)` | `GET {SUPPLIER_BASE_URL}/supplier{A\|B}/hotels?city=` with a 3 s fetch timeout; checks the response with zod; maps to `HotelOffer[]`. | Non-2xx or network error → retryable. Schema mismatch → `INVALID_SUPPLIER_RESPONSE` (non-retryable). |
| `cacheHotels(city, offers)` | `hotelStore.saveCity(city, offers)` | Redis errors → retryable. |

Every activity logs start, success (with count and duration) and failure (with attempt number from `Context.current().info.attempt`).

### API → Temporal

- The `Client` connects lazily and is reused. On startup the connection is retried with backoff until `TEMPORAL_ADDRESS` answers.
- `client.workflow.execute(...)` is wrapped with an HTTP timeout (`WORKFLOW_TIMEOUT_MS`, 15 s).
- `WorkflowFailedError` cause mapping: `ALL_SUPPLIERS_FAILED` → 502; anything else → 503/500.

## 7. Redis design

All keys are per city, with TTL `CACHE_TTL_SECONDS` (default 300).

| Key | Type | Content |
|---|---|---|
| `hotels:{city}` | Sorted set | member = normalised hotel name, score = price |
| `hotels:{city}:offers` | Hash | field = normalised name → `JSON(HotelOffer)` |
| `hotels:{city}:meta` | Hash | `fetchedAt`, `count`, `degraded` — marks the city as cached even when it has 0 hotels |

**Write (atomic):**
```
MULTI
  DEL hotels:{c} hotels:{c}:offers hotels:{c}:meta
  ZADD hotels:{c} p1 n1 p2 n2 …            (skipped if empty)
  HSET hotels:{c}:offers n1 j1 n2 j2 …     (skipped if empty)
  HSET hotels:{c}:meta fetchedAt … count … degraded …
  EXPIRE (all three) TTL
EXEC
```

**Filter read (one Lua script, `EVAL` with 3 keys):**
```lua
if redis.call('EXISTS', KEYS[3]) == 0 then return false end      -- meta missing → cache miss (nil)
local degraded = redis.call('HGET', KEYS[3], 'degraded') or ''
local names = redis.call('ZRANGE', KEYS[1], ARGV[1], ARGV[2], 'BYSCORE')   -- min ?? -inf, max ?? +inf
if #names == 0 then return { degraded } end
local offers = redis.call('HMGET', KEYS[2], unpack(names))
table.insert(offers, 1, degraded)
return offers
```
Running the read as one script means a key expiring between the range query and the hash lookup cannot produce a partial result. It needs Redis 6.2+ for `ZRANGE … BYSCORE`.
Bounds are inclusive by default in Redis, which matches PRD A4. Results come back sorted by score.

Why this shape: the sorted set gives an O(log N + M) range query, done inside Redis. The hash holds the full offer, so the sorted-set members stay short and unique. The meta key tells "cached, but empty" apart from "not cached".

A partial (degraded) result is cached for a shorter time (`DEGRADED_TTL_SECONDS`, 30 s), so a restored supplier shows up quickly.

## 8. API contract

### `GET /api/hotels`

| Param | Type | Rules |
|---|---|---|
| `city` | string | required, 1–64 chars, letters, spaces and hyphens |
| `minPrice` | number | optional, ≥ 0 |
| `maxPrice` | number | optional, ≥ 0, ≥ `minPrice` |

Responses are as in PRD §6. Error body: `{ "error": string, "details"?: unknown }`.

Response headers: `X-Degraded-Suppliers` (when partial), `X-Cache: HIT|MISS` (filtered requests only).

### Mock suppliers

| Method | Path | Notes |
|---|---|---|
| GET | `/supplierA/hotels?city=` | 200 + array (all hotels if `city` is left out). 503 when switched down. |
| GET | `/supplierB/hotels?city=` | Same. |
| POST | `/supplierA/status` / `/supplierB/status` | Body `{ "up": boolean }`. Switches the outage on or off at runtime (used in Postman). |
| GET | `/supplierA/status` / `/supplierB/status` | Current state. |

`GET /livez` returns `200 {"status":"alive"}` whenever the process is serving. The container healthcheck uses it, so a supplier outage (which makes `/health` return 503) does not mark the API container unhealthy.

Initial state can also be set with `SUPPLIER_A_DOWN` / `SUPPLIER_B_DOWN`. The switch is held in the API process's memory; that is fine for a mock.

### `GET /health`

```json
{
  "status": "ok | degraded",
  "suppliers": {
    "supplierA": { "status": "up",   "latencyMs": 4 },
    "supplierB": { "status": "down", "error": "HTTP 503" }
  },
  "dependencies": {
    "redis":    { "status": "up" },
    "temporal": { "status": "up" }
  }
}
```

- Suppliers are checked by calling their real `/hotels` endpoints over HTTP, with a 2 s timeout, in parallel.
- Redis: `PING`. Temporal: `client.connection.healthService.check()` (or describing the namespace).
- 200 when everything is up; otherwise 503.

## 9. Mock data plan

| City | Supplier A | Supplier B | What it shows |
|---|---|---|---|
| delhi | Holtin 6000, Radison 5900, Taj Palace 9500, Lemon Tree 4200 | Holtin 5340, Radison 6100, Taj Palace 9500 (higher commission), ITC Maurya 11000 | A wins, B wins, tie-break, single-supplier hotels |
| mumbai | 3 hotels | 3 hotels, 2 overlapping | A second city |
| goa | 2 hotels | none | Only one supplier has the city |
| other | — | — | Empty result |

A unit test checks that `delhi` has at least two overlaps where each supplier wins at least once.

## 10. Configuration

| Var | Default | Used by |
|---|---|---|
| `PORT` | 3000 | api |
| `SUPPLIER_TIMEOUT_MS` | 3000 | worker |
| `REDIS_URL` | `redis://redis:6379` | api, worker |
| `TEMPORAL_ADDRESS` | `temporal:7233` | api, worker |
| `TEMPORAL_NAMESPACE` | `default` | api, worker |
| `TEMPORAL_TASK_QUEUE` | `hotel-offers` | api, worker |
| `SUPPLIER_BASE_URL` | `http://api:3000` | worker, api (health) |
| `CACHE_TTL_SECONDS` | 300 | worker |
| `DEGRADED_TTL_SECONDS` | 30 | worker |
| `WORKFLOW_TIMEOUT_MS` | 15000 | api |
| `SUPPLIER_A_DOWN` / `SUPPLIER_B_DOWN` | false | api |
| `LOG_LEVEL` | info | all |

## 11. Docker

**Dockerfile** (multi-stage):
1. `node:22-bookworm-slim` build stage: `npm ci`, `npm run build`.
2. `node:22-bookworm-slim` prod-deps stage: `npm ci --omit=dev`.
3. `node:22-bookworm-slim` runtime: production deps and `dist/` only, runs as the non-root `node` user, `HEALTHCHECK` on `/livez`, default `CMD ["node","dist/server.js"]`.

Debian slim (glibc) instead of Alpine because the Temporal worker's native core library needs glibc.

**docker-compose.yml services:**

| Service | Image | Ports | Depends on |
|---|---|---|---|
| `temporal` | `temporalio/temporal` (`server start-dev --ip 0.0.0.0`) | 7233 (gRPC), 8233 (Web UI) | — |
| `redis` | `redis:7-alpine` | 6379 | — |
| `api` | built image | 3000 | redis (healthy), temporal (started) |
| `worker` | built image, `command: node dist/worker.js` | — | redis (healthy), temporal (started), api (healthy) |

**Change from v1:** Temporal has deprecated the `temporalio/auto-setup` image. Instead of Postgres + `temporalio/server` + `temporalio/ui`, the stack runs Temporal's official single-binary dev server image, which includes the Web UI and the `default` namespace. It is one container and fast to start, which suits an assessment. Workflow history is held in memory. Production would use `temporalio/server` with a database, or Temporal Cloud; only `TEMPORAL_ADDRESS` changes. The image tag can be pinned with `TEMPORAL_CLI_VERSION`.

There are healthchecks on redis and api (`/livez`). The API and worker retry their Temporal connection with backoff, since "temporal container started" does not mean "frontend ready".

## 12. Logging and error handling

- Every log line is pino JSON with `service` (`api`/`worker`), `requestId` (API), `workflowId` and `activity` (worker).
- The API creates a `requestId` per request (or reads `X-Request-Id`) and passes it into the workflow memo, so one request's logs can be followed across processes.
- Errors are thrown as typed errors (`ValidationError`, `UpstreamError`, `DependencyError`) and one Express middleware turns them into the responses in PRD §6. Stack traces are never sent to the client.
- On SIGTERM: the worker calls `worker.shutdown()`; the API stops the HTTP server and closes Redis and Temporal connections.

## 13. Testing

| Level | What | Tool |
|---|---|---|
| Unit | `mergeBestOffers`: cheaper wins, single-supplier kept, tie-break, case/whitespace on names, duplicates within one supplier, empty inputs | vitest |
| Unit | Query validation | vitest |
| Unit | `collectBestOffers` (workflow logic) with stub activities: parallel fan-out, one fails, both fail, cache failure | vitest |
| Unit | Activities in `MockActivityEnvironment`: URL/mapping, 5xx/network/timeout retryable, 4xx/invalid payload non-retryable, TTL choice | `@temporalio/testing` |
| Unit | Workflow bundles for the deterministic sandbox | `bundleWorkflowCode` |
| Integration | `hotelStore` against a real Redis: save, filter bounds, open bounds, empty city, TTL | vitest + local redis |
| Integration | API routes with supertest (Temporal client stubbed) | vitest + supertest |
| Harness | Postman collection against `test/e2e/local-harness.ts` (real app, activities, orchestration and Redis; direct calls instead of Temporal scheduling) | newman |
| End to end | `docker compose up --build`, then the Postman collection | newman |

**Postman collection folders:**
1. *Suppliers*: raw A and B for delhi.
2. *Hotels*: delhi (checks: no duplicate names, Holtin from B at 5340, every overlap at the lower price); no-results city; missing city → 400.
3. *Filters*: in-range; min only; max only; min > max → 400; non-numeric → 400.
4. *Outage*: B down → delhi has only A and the header is set → `/health` 503 with B down → B up → full result again.
5. *Health*: all up.

The collection uses a `baseUrl` variable (default `http://localhost:3000`) and test scripts, so `newman run` gives pass/fail.

## 14. Open points

| # | Question | Default if unanswered |
|---|---|---|
| O1 | Should an unfiltered call return cached data instead of always refreshing? | Always refresh (the workflow is the main feature to show). |
| O2 | Deploy target beyond Docker (e.g. Render/Railway)? | Docker Compose locally; the README covers running on any Docker host. |
| O3 | Prices fixed or random? | Fixed, so the Postman checks are stable. |
| O4 | Production Temporal persistence | Out of scope; the dev server image is used (see §11). |
