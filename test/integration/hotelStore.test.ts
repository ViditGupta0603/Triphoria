import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cityKeys, createHotelStore, type HotelStore } from '../../src/redis/hotelStore';
import type { HotelOffer } from '../../src/types';

// needs a real Redis >= 6.2; uses db 15
const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

const delhi: HotelOffer[] = [
  { name: 'Lemon Tree', price: 4200, supplier: 'Supplier A', commissionPct: 8 },
  { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
  { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
  { name: 'Taj Palace', price: 9500, supplier: 'Supplier B', commissionPct: 18 },
  { name: 'ITC Maurya', price: 11000, supplier: 'Supplier B', commissionPct: 14 },
];

let redis: Redis;
let store: HotelStore;

beforeAll(async () => {
  redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect();
  store = createHotelStore(redis);
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await redis?.quit();
});

describe('hotelStore', () => {
  it('returns null for a city that is not cached', async () => {
    expect(await store.filterByPrice('delhi')).toBeNull();
  });

  it('stores the list in a sorted set + hash and returns it sorted by price', async () => {
    await store.saveCity('delhi', delhi, { ttlSeconds: 60 });

    const k = cityKeys('delhi');
    expect(await redis.zcard(k.set)).toBe(5);
    expect(await redis.zscore(k.set, 'holtin')).toBe('5340');
    expect(JSON.parse((await redis.hget(k.offers, 'holtin')) ?? '{}')).toEqual(delhi[1]);
    expect(await redis.hget(k.meta, 'count')).toBe('5');

    const cached = await store.filterByPrice('delhi');
    expect(cached).toEqual({ hotels: delhi, degradedSuppliers: [] });
  });

  it('filters by price inside Redis with inclusive bounds', async () => {
    await store.saveCity('delhi', delhi, { ttlSeconds: 60 });
    const r = await store.filterByPrice('delhi', { minPrice: 5340, maxPrice: 9500 });
    expect(r?.hotels.map((h) => h.name)).toEqual(['Holtin', 'Radison', 'Taj Palace']);
  });

  it('supports open-ended ranges', async () => {
    await store.saveCity('delhi', delhi, { ttlSeconds: 60 });
    expect((await store.filterByPrice('delhi', { minPrice: 9000 }))?.hotels.map((h) => h.name)).toEqual([
      'Taj Palace',
      'ITC Maurya',
    ]);
    expect((await store.filterByPrice('delhi', { maxPrice: 5000 }))?.hotels.map((h) => h.name)).toEqual([
      'Lemon Tree',
    ]);
  });

  it('returns an empty list (not null) when the range matches nothing', async () => {
    await store.saveCity('delhi', delhi, { ttlSeconds: 60 });
    expect(await store.filterByPrice('delhi', { minPrice: 1, maxPrice: 100 })).toEqual({
      hotels: [],
      degradedSuppliers: [],
    });
  });

  it('caches an empty city so it is distinguishable from a cache miss', async () => {
    await store.saveCity('atlantis', [], { ttlSeconds: 60 });
    expect(await store.filterByPrice('atlantis')).toEqual({ hotels: [], degradedSuppliers: [] });
  });

  it('replaces the previous list atomically on refresh', async () => {
    await store.saveCity('delhi', delhi, { ttlSeconds: 60 });
    await store.saveCity('delhi', [delhi[0] as HotelOffer], { ttlSeconds: 60 });
    expect((await store.filterByPrice('delhi'))?.hotels).toEqual([delhi[0]]);
    expect(await redis.hlen(cityKeys('delhi').offers)).toBe(1);
  });

  it('records degraded suppliers', async () => {
    await store.saveCity('delhi', delhi.slice(0, 2), { ttlSeconds: 60, degradedSuppliers: ['B'] });
    expect((await store.filterByPrice('delhi'))?.degradedSuppliers).toEqual(['B']);
  });

  it('sets a TTL on every key', async () => {
    await store.saveCity('delhi', delhi, { ttlSeconds: 42 });
    const k = cityKeys('delhi');
    for (const key of [k.set, k.offers, k.meta]) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(42);
    }
  });

  it('treats city names case-insensitively', async () => {
    await store.saveCity('Delhi', delhi, { ttlSeconds: 60 });
    expect((await store.filterByPrice('  DELHI '))?.hotels).toHaveLength(5);
  });

  it('expires the whole city together', async () => {
    await store.saveCity('delhi', delhi, { ttlSeconds: 1 });
    await new Promise((r) => setTimeout(r, 1_200));
    expect(await store.filterByPrice('delhi')).toBeNull();
  });
});
