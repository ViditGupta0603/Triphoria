# PRD — Hotel Offer Orchestrator (Triphoria)

| | |
|---|---|
| **Owner** | Advay |
| **Status** | v1.1 |
| **Date** | 2026-11-21 |
| **Source** | "Assessment – Backend (Redis)" take-home |
| **Stack (mandated)** | Node.js (TypeScript), Express, Temporal, Redis, Docker Compose |

---

## 1. Problem

A travel product gets hotel offers from more than one supplier. Two suppliers often list the same hotel at different prices. If we show both, the list is noisy and the user may book the worse deal. We need one service that asks every supplier, merges what they return, keeps only the cheapest offer for each hotel, and lets the client filter that list by price.

## 2. Goals

1. One endpoint returns a de-duplicated, best-priced list of hotels for a city.
2. Supplier calls run in parallel and are orchestrated by **Temporal**, so retries, timeouts and partial failures are handled the same way every time.
3. The merged list is stored in **Redis**, and price-range filtering runs **inside Redis**, not in application memory.
4. The whole system starts with a single `docker compose up`.
5. A reviewer can check every behaviour with the Postman collection we ship.

### Non-goals

- Real supplier integrations, authentication or payments.
- Pagination, sorting options other than by price, or a UI.
- Persistent storage beyond the Redis cache.
- Production-grade multi-region deployment.

## 3. Users

| User | Need |
|---|---|
| **Client app / API consumer** | A clean list of hotels with the best price and the supplier that offers it. |
| **Assessment reviewer** | Runs the project fast, follows the README, uses Postman to see overlaps, the empty-city case and the supplier-down case. |
| **Operator** | Uses `/health` to see whether each supplier (and our dependencies) is up. |

## 4. Functional requirements

### FR-1 — Get best offers for a city
`GET /api/hotels?city=delhi`

- Starts a Temporal workflow that calls Supplier A and Supplier B **in parallel**.
- Each supplier returns the hotels it has for that city.
- Hotels are de-duplicated **by name**.
  - Hotel in both lists → keep the **cheaper** offer.
  - Hotel in only one list → keep that offer.
- Saves the final list to Redis.
- Returns the list as a JSON array:

```json
[
  { "name": "Holtin",  "price": 5340, "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison", "price": 5900, "supplier": "Supplier A", "commissionPct": 13 }
]
```

### FR-2 — Filter by price range
`GET /api/hotels?city=delhi&minPrice=<min>&maxPrice=<max>`

- Filters the de-duplicated list stored in Redis by price, **inside Redis** (sorted-set range query).
- If the city's list is not in Redis yet, or has expired, the workflow runs first and stores it, then the filter runs.
- Same response shape as FR-1.

### FR-3 — Mock supplier APIs
`GET /supplierA/hotels?city=<city>` and `GET /supplierB/hotels?city=<city>`

- Served by our own service. Static, hard-coded data.
- Supplier item shape: `{ hotelId, name, price, city, commissionPct }`.
- The data **must** include hotel names that both suppliers list, at different prices, so the comparison means something. It should also include hotels that only one supplier lists, and more than one city.

### FR-4 — Simulate a supplier outage (optional in brief, in scope)
- Each mock supplier can be switched "down" at runtime, so it returns HTTP 503. Switching back restores it.
- With one supplier down, `/api/hotels` still returns the other supplier's hotels.
- With both down, `/api/hotels` returns an error.

### FR-5 — Health check (bonus, in scope)
`GET /health`

- Reports the status of **Supplier A** and **Supplier B** separately (required by the bonus).
- Also reports Redis and Temporal, since the API cannot work without them.
- HTTP 200 when everything is up; HTTP 503 with details when anything is down.

### FR-6 — Logging and error handling (bonus, in scope)
- Structured logs in activities and workflows (start, success, retry, failure, duration).
- Clear errors for bad input, supplier failure and dependency failure (see §6).

## 5. Business rules and assumptions

The brief leaves these open. We decide them here and record them in the README.

| # | Topic | Decision | Reason |
|---|---|---|---|
| A1 | City matching | Case-insensitive, trimmed (`Delhi` = `delhi`). | Avoids false "no results". |
| A2 | Dedupe key | Hotel name, trimmed and lowercased. The returned `name` is the supplier's original spelling. | The brief says "by name". Fuzzy matching ("Radisson" vs "Radison") is out of scope. |
| A3 | Equal prices | Keep the offer with the higher `commissionPct`; if that is also equal, keep Supplier A. | The answer must be the same on every run; higher commission is better for the business. |
| A4 | Price bounds | Inclusive. Either bound may be left out (open-ended). `minPrice > maxPrice` → 400. Non-numeric or negative → 400. | Predictable, and easy to explain. |
| A5 | Output order | Sorted by price, lowest first. | Natural for a "best offer" list; Redis returns this order anyway. |
| A6 | Unknown city | 200 with `[]`. | "No hotels" is a valid answer, not an error. |
| A7 | Missing `city` | 400. | `city` is required. |
| A8 | One supplier down | 200 with the healthy supplier's hotels. A response header `X-Degraded-Suppliers` names the failed supplier. Body stays a plain array, as the brief specifies. | Partial results are better than none; the header keeps the contract unchanged. |
| A9 | Both suppliers down | 502 with an error body. | Nothing to return. |
| A10 | Cache freshness | The Redis list for a city expires after a set time (default 5 minutes). An unfiltered request always refreshes it. | Fresh data on the main call; fast, Redis-native filtering on repeat calls. |
| A11 | Output fields | `name`, `price`, `supplier`, `commissionPct` only. `hotelId` and `city` are dropped. | Matches the response format in the brief. |

## 6. Error behaviour

| Case | Status | Body |
|---|---|---|
| Success (any number of hotels, including 0) | 200 | Array of hotels |
| One supplier failed | 200 + `X-Degraded-Suppliers` header | Array from the healthy supplier |
| Missing/invalid `city`, bad `minPrice`/`maxPrice`, min > max | 400 | `{ "error": "...", "details": ... }` |
| Both suppliers failed | 502 | `{ "error": "All suppliers unavailable" }` |
| Redis or Temporal unreachable | 503 | `{ "error": "..." }` |
| Unexpected error | 500 | `{ "error": "Internal server error" }` (details only in logs) |

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Latency | p95 for an unfiltered call under ~1 s locally with both suppliers up (the two calls run in parallel). A filtered call served from Redis is a few ms. |
| Resilience | Supplier calls have a timeout and a small number of retries. A failed supplier cannot block the other. |
| Correctness | De-dupe and best-price selection are a pure function with unit tests. |
| Deployability | `docker compose up --build` starts API, worker, Redis and Temporal (dev server with Web UI) with no manual steps. |
| Observability | Structured JSON logs. Workflows can be inspected in the Temporal Web UI. |
| Code quality | TypeScript strict mode, linted, clear module boundaries, input validated. |

## 8. Deliverables (submission checklist)

- [ ] GitHub repository with source code
- [ ] `Dockerfile` (plus `docker-compose.yml` for the full stack)
- [ ] `README.md` with setup, run, deploy and test steps, and the assumptions from §5
- [ ] Postman collection (`.json`) covering:
  - [ ] Valid city with overlaps (`city=delhi`)
  - [ ] City with no results
  - [ ] Price filter (in-range, open-ended, invalid input)
  - [ ] One supplier down → partial results; restore
  - [ ] `/health`
- [ ] Bonus: `/health` with per-supplier status
- [ ] Bonus: logging and error handling in activities and workflows

## 9. Acceptance criteria

1. `GET /api/hotels?city=delhi` returns each overlapping hotel **once**, at the **lower** of the two supplier prices, with the right `supplier` label.
2. Hotels listed by only one supplier appear with that supplier's offer.
3. Running the request starts a workflow that appears in the Temporal UI with two supplier activities running in parallel.
4. After the call, the list is in Redis (checkable with `redis-cli`).
5. `minPrice`/`maxPrice` results match a Redis `ZRANGE … BYSCORE` on the stored set; bounds are inclusive.
6. `GET /api/hotels?city=atlantis` → `200 []`.
7. With Supplier B switched down, `city=delhi` returns only Supplier A's hotels with `X-Degraded-Suppliers: Supplier B`; `/health` shows B as down.
8. A fresh clone runs end to end by following only the README.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Temporal stack is slow or heavy to start | Use the standard Temporal Docker images; API and worker wait for Temporal and retry the connection on startup. |
| Endless retries when a supplier is down hide the outage and slow the response | Short activity timeout and capped retries; the workflow catches the final failure and continues with partial data. |
| Mock data has no overlaps, so the comparison is meaningless | Overlaps are fixed in the data and checked by a unit test. |
| Concurrent refreshes for the same city write over each other | Each write replaces the whole city set atomically (MULTI/EXEC), so readers never see a half-written list. |

## 11. Milestones

1. PRD and TRD (this doc and `TRD.md`)
2. Project scaffold, mock suppliers, pure merge logic and unit tests
3. Temporal workflow, activities and worker
4. Redis storage and filtering
5. API, validation, health check, logging
6. Docker / Compose
7. Postman collection, README, end-to-end check
