import type { Redis } from 'ioredis';
import { hotelKey, normaliseCity } from '../domain/merge';
import type { HotelOffer, SupplierId } from '../types';

/**
 * Redis layout per city (all keys share one TTL):
 *   hotels:{city}         ZSET  member = normalised hotel name, score = price
 *   hotels:{city}:offers  HASH  normalised hotel name -> JSON(HotelOffer)
 *   hotels:{city}:meta    HASH  fetchedAt, count, degraded — marks the city as cached (even if empty)
 */
export const cityKeys = (city: string) => {
  const c = normaliseCity(city);
  return {
    set: `hotels:${c}`,
    offers: `hotels:${c}:offers`,
    meta: `hotels:${c}:meta`,
  };
};

export interface SaveOptions {
  ttlSeconds: number;
  degradedSuppliers?: SupplierId[];
}

export interface PriceRange {
  minPrice?: number;
  maxPrice?: number;
}

export interface CachedCity {
  hotels: HotelOffer[];
  degradedSuppliers: SupplierId[];
}

export interface HotelStore {
  saveCity(city: string, hotels: HotelOffer[], options: SaveOptions): Promise<void>;
  /** Price-range query executed inside Redis. Returns null when the city is not cached. */
  filterByPrice(city: string, range?: PriceRange): Promise<CachedCity | null>;
  ping(): Promise<boolean>;
}

/**
 * Atomic read: checks the city is cached, runs ZRANGE … BYSCORE (inclusive
 * bounds) and HMGETs the matching offers, all in one server-side step so a
 * key expiring mid-read cannot return a partial result.
 */
const FILTER_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 0 then return false end
local degraded = redis.call('HGET', KEYS[3], 'degraded') or ''
local names = redis.call('ZRANGE', KEYS[1], ARGV[1], ARGV[2], 'BYSCORE')
if #names == 0 then return { degraded } end
local offers = redis.call('HMGET', KEYS[2], unpack(names))
table.insert(offers, 1, degraded)
return offers
`;

const parseDegraded = (raw: unknown): SupplierId[] =>
  typeof raw === 'string' && raw.length > 0
    ? (raw.split(',').filter((s) => s === 'A' || s === 'B') as SupplierId[])
    : [];

export const createHotelStore = (redis: Redis): HotelStore => ({
  async saveCity(city, hotels, { ttlSeconds, degradedSuppliers = [] }) {
    const k = cityKeys(city);
    const tx = redis.multi().del(k.set, k.offers, k.meta);

    if (hotels.length > 0) {
      const zaddArgs = hotels.flatMap((h) => [h.price, hotelKey(h.name)] as const);
      tx.zadd(k.set, ...zaddArgs);
      tx.hset(k.offers, Object.fromEntries(hotels.map((h) => [hotelKey(h.name), JSON.stringify(h)])));
      tx.expire(k.set, ttlSeconds);
      tx.expire(k.offers, ttlSeconds);
    }

    tx.hset(k.meta, {
      fetchedAt: new Date().toISOString(),
      count: String(hotels.length),
      degraded: degradedSuppliers.join(','),
    });
    tx.expire(k.meta, ttlSeconds);

    const results = await tx.exec();
    const failed = results?.find(([err]) => err);
    if (!results || failed) {
      throw new Error(`Redis transaction failed: ${failed?.[0]?.message ?? 'aborted'}`);
    }
  },

  async filterByPrice(city, range = {}) {
    const k = cityKeys(city);
    const min = range.minPrice === undefined ? '-inf' : String(range.minPrice);
    const max = range.maxPrice === undefined ? '+inf' : String(range.maxPrice);

    const reply = (await redis.eval(FILTER_SCRIPT, 3, k.set, k.offers, k.meta, min, max)) as
      | (string | null)[]
      | null;
    if (reply === null) return null;

    const [degraded, ...rawOffers] = reply;
    const hotels = rawOffers
      .filter((v): v is string => typeof v === 'string')
      .map((v) => JSON.parse(v) as HotelOffer);

    return { hotels, degradedSuppliers: parseDegraded(degraded) };
  },

  async ping() {
    return (await redis.ping()) === 'PONG';
  },
});
