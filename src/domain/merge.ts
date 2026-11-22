/**
 * Pure, deterministic merge logic.
 *
 * This module is imported by the Temporal workflow, so it must stay free of
 * Node APIs, I/O, randomness and wall-clock time.
 */
import type { HotelOffer } from '../types';

/** Key used to decide that two offers are for the same hotel. */
export const hotelKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Normalised form of a city name used for lookups and Redis keys. */
export const normaliseCity = (city: string): string => city.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Returns true when `candidate` should replace `current`.
 * Order: lower price → higher commission → Supplier A.
 */
export const isBetterOffer = (candidate: HotelOffer, current: HotelOffer): boolean => {
  if (candidate.price !== current.price) return candidate.price < current.price;
  if (candidate.commissionPct !== current.commissionPct) {
    return candidate.commissionPct > current.commissionPct;
  }
  return candidate.supplier === 'Supplier A' && current.supplier !== 'Supplier A';
};

/** Sort by price ascending, then by name for a stable order. */
export const compareOffers = (a: HotelOffer, b: HotelOffer): number =>
  a.price - b.price || hotelKey(a.name).localeCompare(hotelKey(b.name));

/**
 * De-duplicates offers by hotel name and keeps the best offer for each hotel.
 * Accepts any number of supplier lists (and tolerates duplicates within one list).
 */
export const mergeBestOffers = (...offerLists: HotelOffer[][]): HotelOffer[] => {
  const best = new Map<string, HotelOffer>();

  for (const list of offerLists) {
    for (const offer of list) {
      const key = hotelKey(offer.name);
      const current = best.get(key);
      if (!current || isBetterOffer(offer, current)) best.set(key, offer);
    }
  }

  return [...best.values()].sort(compareOffers);
};
