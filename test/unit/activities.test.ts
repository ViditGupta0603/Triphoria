import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { describe, expect, it, vi } from 'vitest';
import type { HotelStore } from '../../src/redis/hotelStore';
import { createActivities } from '../../src/temporal/activities';
import {
  INVALID_SUPPLIER_RESPONSE,
  SUPPLIER_CLIENT_ERROR,
  SUPPLIER_UNAVAILABLE,
} from '../../src/temporal/constants';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const store = (): HotelStore => ({
  saveCity: vi.fn(async () => {}),
  filterByPrice: vi.fn(async () => null),
  ping: vi.fn(async () => true),
});

const setup = (fetchImpl: typeof fetch, s: HotelStore = store()) => ({
  store: s,
  acts: createActivities({
    store: s,
    supplierBaseUrl: 'http://suppliers.test',
    supplierTimeoutMs: 1_000,
    cacheTtlSeconds: 300,
    degradedTtlSeconds: 30,
    fetchImpl,
  }),
});

const silent = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const env = () => new MockActivityEnvironment(undefined, { logger: silent });

const expectFailure = async (p: Promise<unknown>, type: string, nonRetryable: boolean) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApplicationFailure);
  expect((err as ApplicationFailure).type).toBe(type);
  expect((err as ApplicationFailure).nonRetryable).toBe(nonRetryable);
};

describe('fetchSupplierHotels', () => {
  it('calls the right URL and maps supplier hotels to offers', async () => {
    const fetchImpl = vi.fn(async () =>
      json([
        { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
        { hotelId: 'a9', name: 'Elsewhere', price: 1, city: 'goa', commissionPct: 1 },
      ]),
    ) as unknown as typeof fetch;
    const { acts } = setup(fetchImpl);

    const offers = await env().run(acts.fetchSupplierHotels, 'A', 'delhi');

    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as URL;
    expect(url.toString()).toBe('http://suppliers.test/supplierA/hotels?city=delhi');
    // Wrong-city rows are dropped; hotelId and city are not exposed.
    expect(offers).toEqual([{ name: 'Holtin', price: 6000, supplier: 'Supplier A', commissionPct: 10 }]);
  });

  it('throws a retryable failure on 5xx', async () => {
    const { acts } = setup(async () => json({ error: 'down' }, 503));
    await expectFailure(env().run(acts.fetchSupplierHotels, 'B', 'delhi'), SUPPLIER_UNAVAILABLE, false);
  });

  it('throws a retryable failure on network errors', async () => {
    const { acts } = setup(async () => {
      throw new TypeError('fetch failed');
    });
    await expectFailure(env().run(acts.fetchSupplierHotels, 'B', 'delhi'), SUPPLIER_UNAVAILABLE, false);
  });

  it('throws a non-retryable failure on 4xx', async () => {
    const { acts } = setup(async () => json({}, 404));
    await expectFailure(env().run(acts.fetchSupplierHotels, 'A', 'delhi'), SUPPLIER_CLIENT_ERROR, true);
  });

  it('throws a non-retryable failure on an invalid payload', async () => {
    const { acts } = setup(async () => json([{ name: 'No price' }]));
    await expectFailure(env().run(acts.fetchSupplierHotels, 'A', 'delhi'), INVALID_SUPPLIER_RESPONSE, true);
  });

  it('throws a non-retryable failure on non-JSON', async () => {
    const { acts } = setup(async () => new Response('<html>', { status: 200 }));
    await expectFailure(env().run(acts.fetchSupplierHotels, 'A', 'delhi'), INVALID_SUPPLIER_RESPONSE, true);
  });

  it('times out slow suppliers as a retryable failure', async () => {
    const slow: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const s = store();
    const acts = createActivities({
      store: s,
      supplierBaseUrl: 'http://suppliers.test',
      supplierTimeoutMs: 50,
      cacheTtlSeconds: 300,
      degradedTtlSeconds: 30,
      fetchImpl: slow,
    });
    await expectFailure(env().run(acts.fetchSupplierHotels, 'A', 'delhi'), SUPPLIER_UNAVAILABLE, false);
  });
});

describe('cacheHotels', () => {
  const hotels = [{ name: 'Holtin', price: 5340, supplier: 'Supplier B' as const, commissionPct: 20 }];

  it('uses the normal TTL when all suppliers responded', async () => {
    const { acts, store: s } = setup(fetch);
    await env().run(acts.cacheHotels, 'delhi', hotels, []);
    expect(s.saveCity).toHaveBeenCalledWith('delhi', hotels, { ttlSeconds: 300, degradedSuppliers: [] });
  });

  it('uses the short TTL for partial results', async () => {
    const { acts, store: s } = setup(fetch);
    await env().run(acts.cacheHotels, 'delhi', hotels, ['A']);
    expect(s.saveCity).toHaveBeenCalledWith('delhi', hotels, { ttlSeconds: 30, degradedSuppliers: ['A'] });
  });

  it('rethrows store errors so Temporal retries', async () => {
    const s = store();
    s.saveCity = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const { acts } = setup(fetch, s);
    await expect(env().run(acts.cacheHotels, 'delhi', hotels, [])).rejects.toThrow('ECONNREFUSED');
  });
});
