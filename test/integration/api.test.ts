import { ApplicationFailure } from '@temporalio/common';
import { WorkflowFailedError } from '@temporalio/client';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthDeps } from '../../src/api/health';
import { createApp } from '../../src/app';
import { mergeBestOffers } from '../../src/domain/merge';
import { createHotelStore, type HotelStore } from '../../src/redis/hotelStore';
import { getSupplierHotels, setSupplierUp, isSupplierUp } from '../../src/suppliers/router';
import type { HotelOffersRunner } from '../../src/temporal/client';
import { ALL_SUPPLIERS_FAILED } from '../../src/temporal/constants';
import { supplierLabel, type HotelOffer, type SupplierId } from '../../src/types';

// real Redis, with a fake runner standing in for the Temporal workflow
const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/14';

let redis: Redis;
let store: HotelStore;

const fakeRunner = (): HotelOffersRunner => ({
  run: vi.fn(async (city: string) => {
    const lists: HotelOffer[][] = [];
    const degradedSuppliers: SupplierId[] = [];
    for (const id of ['A', 'B'] as const) {
      if (!isSupplierUp(id)) {
        degradedSuppliers.push(id);
        continue;
      }
      lists.push(
        getSupplierHotels(id, city).map((h) => ({
          name: h.name,
          price: h.price,
          supplier: supplierLabel(id),
          commissionPct: h.commissionPct,
        })),
      );
    }
    if (lists.length === 0) {
      const cause = ApplicationFailure.nonRetryable('All suppliers unavailable', ALL_SUPPLIERS_FAILED, {
        failures: degradedSuppliers,
      });
      throw new WorkflowFailedError('Workflow execution failed', cause, 'NON_RETRYABLE_FAILURE');
    }
    const hotels = mergeBestOffers(...lists);
    await store.saveCity(city, hotels, { ttlSeconds: 60, degradedSuppliers });
    return { city, hotels, degradedSuppliers };
  }),
});

const healthDeps = (overrides: Partial<HealthDeps> = {}): HealthDeps => ({
  checkSupplier: async (id) => {
    if (!isSupplierUp(id)) throw new Error('HTTP 503');
  },
  checkRedis: async () => {
    await redis.ping();
  },
  checkTemporal: async () => {},
  timeoutMs: 500,
  ...overrides,
});

const build = (runner = fakeRunner(), health = healthDeps(), workflowTimeoutMs = 2_000) => ({
  runner,
  app: createApp({ hotels: { runner, store, workflowTimeoutMs }, health }),
});

beforeAll(async () => {
  redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect();
  store = createHotelStore(redis);
});

beforeEach(async () => {
  await redis.flushdb();
  setSupplierUp('A', true);
  setSupplierUp('B', true);
});

afterAll(async () => {
  await redis?.quit();
});

describe('GET /api/hotels', () => {
  it('returns de-duplicated best offers for delhi in the required shape', async () => {
    const { app } = build();
    const res = await request(app).get('/api/hotels?city=delhi');

    expect(res.status).toBe(200);
    expect(res.headers['x-degraded-suppliers']).toBeUndefined();
    expect(res.body).toEqual([
      { name: 'Lemon Tree', price: 4200, supplier: 'Supplier A', commissionPct: 8 },
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
      { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
      { name: 'Taj Palace', price: 9500, supplier: 'Supplier B', commissionPct: 18 },
      { name: 'ITC Maurya', price: 11000, supplier: 'Supplier B', commissionPct: 14 },
    ]);
    const names = res.body.map((h: HotelOffer) => h.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('saves the list in Redis', async () => {
    const { app } = build();
    await request(app).get('/api/hotels?city=delhi');
    expect(await redis.zcard('hotels:delhi')).toBe(5);
  });

  it('normalises the city', async () => {
    const { app, runner } = build();
    const res = await request(app).get('/api/hotels?city=%20Delhi%20');
    expect(res.status).toBe(200);
    expect(runner.run).toHaveBeenCalledWith('delhi', expect.any(String));
  });

  it('returns 200 [] for a city with no hotels', async () => {
    const { app } = build();
    const res = await request(app).get('/api/hotels?city=atlantis');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 400 when city is missing or invalid', async () => {
    const { app, runner } = build();
    for (const q of ['', '?city=', '?city=%20', '?city=123', '?city=a&city=b']) {
      const res = await request(app).get(`/api/hotels${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error).toBe('Invalid query parameters');
    }
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('returns partial results with a header when one supplier is down', async () => {
    setSupplierUp('B', false);
    const { app } = build();
    const res = await request(app).get('/api/hotels?city=delhi');
    expect(res.status).toBe(200);
    expect(res.headers['x-degraded-suppliers']).toBe('Supplier B');
    expect(res.body.every((h: HotelOffer) => h.supplier === 'Supplier A')).toBe(true);
    expect(res.body).toHaveLength(4);
  });

  it('returns 502 when every supplier is down', async () => {
    setSupplierUp('A', false);
    setSupplierUp('B', false);
    const { app } = build();
    const res = await request(app).get('/api/hotels?city=delhi');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('All suppliers unavailable');
  });

  it('returns 503 when the workflow times out', async () => {
    const runner: HotelOffersRunner = { run: () => new Promise(() => {}) };
    const { app } = build(runner, healthDeps(), 50);
    const res = await request(app).get('/api/hotels?city=delhi');
    expect(res.status).toBe(503);
  });

  it('returns 503 when Temporal is unreachable', async () => {
    const runner: HotelOffersRunner = {
      run: async () => {
        throw new Error('14 UNAVAILABLE: connection refused');
      },
    };
    const { app } = build(runner);
    const res = await request(app).get('/api/hotels?city=delhi');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Orchestration service unavailable');
  });

  it('echoes a provided X-Request-Id and generates one otherwise', async () => {
    const { app } = build();
    const withId = await request(app).get('/api/hotels?city=delhi').set('X-Request-Id', 'abc-123');
    expect(withId.headers['x-request-id']).toBe('abc-123');
    const without = await request(app).get('/api/hotels?city=delhi');
    expect(without.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('GET /api/hotels with price filters', () => {
  it('runs the workflow on a cache miss, then filters in Redis', async () => {
    const { app, runner } = build();
    const res = await request(app).get('/api/hotels?city=delhi&minPrice=5000&maxPrice=9500');
    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.body.map((h: HotelOffer) => h.name)).toEqual(['Holtin', 'Radison', 'Taj Palace']);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('serves repeat filters from Redis without running the workflow', async () => {
    const { app, runner } = build();
    await request(app).get('/api/hotels?city=delhi');
    const res = await request(app).get('/api/hotels?city=delhi&minPrice=6000');
    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.body.map((h: HotelOffer) => h.name)).toEqual(['Taj Palace', 'ITC Maurya']);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('treats bounds as inclusive and supports max only', async () => {
    const { app } = build();
    const res = await request(app).get('/api/hotels?city=delhi&maxPrice=5340');
    expect(res.body.map((h: HotelOffer) => h.price)).toEqual([4200, 5340]);
  });

  it('returns [] when nothing is in range', async () => {
    const { app } = build();
    const res = await request(app).get('/api/hotels?city=delhi&minPrice=1&maxPrice=100');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('rejects invalid bounds', async () => {
    const { app } = build();
    for (const q of ['minPrice=abc', 'maxPrice=-5', 'minPrice=9000&maxPrice=1000', 'minPrice=1e3']) {
      const res = await request(app).get(`/api/hotels?city=delhi&${q}`);
      expect(res.status, q).toBe(400);
    }
  });

  it('returns 503 when Redis fails during filtering', async () => {
    const broken: HotelStore = {
      ...store,
      filterByPrice: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const runner = fakeRunner();
    const app = createApp({ hotels: { runner, store: broken, workflowTimeoutMs: 2_000 }, health: healthDeps() });
    const res = await request(app).get('/api/hotels?city=delhi&minPrice=1');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Cache unavailable');
  });
});

describe('GET /health', () => {
  it('returns 200 with every component up', async () => {
    const { app } = build();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.suppliers.supplierA.status).toBe('up');
    expect(res.body.suppliers.supplierB.status).toBe('up');
    expect(res.body.dependencies.redis.status).toBe('up');
    expect(res.body.dependencies.temporal.status).toBe('up');
  });

  it('reports a down supplier with 503', async () => {
    setSupplierUp('B', false);
    const { app } = build();
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.suppliers.supplierA.status).toBe('up');
    expect(res.body.suppliers.supplierB).toMatchObject({ status: 'down', error: 'HTTP 503' });
  });

  it('times out slow checks', async () => {
    const { app } = build(fakeRunner(), healthDeps({ checkTemporal: () => new Promise(() => {}) }));
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.dependencies.temporal.error).toMatch(/timed out/);
  });
});

describe('misc', () => {
  it('returns 404 JSON for unknown routes', async () => {
    const { app } = build();
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/);
  });

  it('returns 400 for malformed JSON bodies', async () => {
    const { app } = build();
    const res = await request(app).post('/supplierA/status').set('content-type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
  });
});
