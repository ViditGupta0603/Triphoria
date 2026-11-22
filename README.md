# Triphoria - Hotel Offer Orchestrator

Fetches hotel offers from two suppliers in parallel using a Temporal workflow, removes duplicate hotels (keeping the cheaper offer), stores the result in Redis and supports price-range filtering in Redis.

Stack: Node.js 22, TypeScript, Express, Temporal, Redis, Docker Compose.

## Running

```bash
docker compose up --build
```

- API: http://localhost:3000
- Temporal UI: http://localhost:8233
- Redis: localhost:6379

If a port is already taken, set a different one in a `.env` file, e.g. `API_PORT=3001` (also `REDIS_PORT`, `TEMPORAL_PORT`, `TEMPORAL_UI_PORT`).

```bash
curl "http://localhost:3000/api/hotels?city=delhi"
curl "http://localhost:3000/api/hotels?city=delhi&minPrice=5000&maxPrice=9500"
curl "http://localhost:3000/health"
```

### Without Docker

Needs Node 22+, Redis 6.2+ and the Temporal CLI.

```bash
npm ci
cp .env.example .env
npm run build
temporal server start-dev
redis-server
npm start              # API
npm run start:worker   # worker
```

## Endpoints

### GET /api/hotels?city=delhi

Starts `hotelOffersWorkflow`, which calls Supplier A and Supplier B in parallel, de-duplicates hotels by name keeping the cheaper offer, saves the list to Redis and returns it sorted by price.

```json
[
  { "name": "Lemon Tree", "price": 4200, "supplier": "Supplier A", "commissionPct": 8 },
  { "name": "Holtin", "price": 5340, "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison", "price": 5900, "supplier": "Supplier A", "commissionPct": 13 },
  { "name": "Taj Palace", "price": 9500, "supplier": "Supplier B", "commissionPct": 18 },
  { "name": "ITC Maurya", "price": 11000, "supplier": "Supplier B", "commissionPct": 14 }
]
```

### GET /api/hotels?city=delhi&minPrice=5000&maxPrice=9500

Filters the stored list in Redis with `ZRANGE ... BYSCORE`. Bounds are inclusive and either one can be omitted. If the city isn't cached yet, the workflow runs first. The `X-Cache` header shows `HIT` or `MISS`.

### GET /health

Status of Supplier A, Supplier B, Redis and Temporal. Returns 200 if everything is up, 503 otherwise.

### Mock suppliers

- `GET /supplierA/hotels?city=delhi`, `GET /supplierB/hotels?city=delhi`
- `POST /supplierA/status` or `/supplierB/status` with `{"up": false}` makes that supplier return 503 (set `{"up": true}` to restore). They can also start down with `SUPPLIER_A_DOWN=true` / `SUPPLIER_B_DOWN=true`.

Mock data covers delhi (overlapping hotels, each supplier winning some), mumbai (partial overlap) and goa (Supplier A only). Any other city returns `[]`.

### Status codes

| Case | Status |
|---|---|
| Success, including no results | 200 |
| One supplier failed | 200, results from the other supplier, header `X-Degraded-Suppliers` |
| Invalid `city`, `minPrice` or `maxPrice` | 400 |
| Both suppliers failed | 502 |
| Redis or Temporal unavailable | 503 |

## Design notes

- Hotels are matched by name, ignoring case and extra spaces.
- On equal prices, the offer with the higher commission wins; if that's also equal, Supplier A.
- City is case-insensitive.
- If one supplier fails after retries, the other supplier's results are returned and the failure is flagged in a header so the response body stays a plain array.
- A request without a price filter always runs the workflow and refreshes the cache (TTL 300s). Filtered requests use the cache. Partial results are cached for 30s only.

**Temporal:** supplier activities have a 5s timeout and up to 3 attempts with backoff. 5xx, network errors and timeouts are retried; 4xx and invalid payloads are not. The workflow logic lives in `src/temporal/orchestrate.ts` and the merge in `src/domain/merge.ts`, both pure functions so they're deterministic and easy to test.

**Redis**, per city (all keys share a TTL):

| Key | Type | Content |
|---|---|---|
| `hotels:<city>` | sorted set | hotel name, score = price |
| `hotels:<city>:offers` | hash | hotel name -> offer JSON |
| `hotels:<city>:meta` | hash | fetch time, count, degraded suppliers |

Writes use `MULTI`/`EXEC`. The filter is a Lua script (range query + hash lookup) so it's atomic.

```bash
docker compose exec redis redis-cli ZRANGE hotels:delhi 5000 9500 BYSCORE WITHSCORES
```

## Postman

Import `postman/Triphoria.postman_collection.json` and run the folders in order. `baseUrl` defaults to `http://localhost:3000`. It covers health, raw supplier responses, de-duplication, the no-results case, price filters, validation errors and the supplier outage scenario.

Or from the command line:

```bash
npm run test:postman
# different port:
npx newman run postman/Triphoria.postman_collection.json --env-var baseUrl=http://localhost:3001
```

## Tests

```bash
npm test            # unit + integration (integration needs Redis on localhost:6379)
npm run test:unit
```

## Configuration

See `.env.example`. Main variables: `PORT`, `REDIS_URL`, `TEMPORAL_ADDRESS`, `SUPPLIER_BASE_URL`, `CACHE_TTL_SECONDS`, `WORKFLOW_TIMEOUT_MS`, `LOG_LEVEL`.

## Deployment

`docker compose up --build -d` runs everything on any Docker host. The API and worker use the same image (`node dist/server.js` and `node dist/worker.js`), so they can be scaled separately. For production, point `TEMPORAL_ADDRESS` at a Temporal cluster with persistence or Temporal Cloud; the compose setup uses the Temporal dev server, which keeps history in memory.
