// Used inside the workflow sandbox: keep this file free of I/O and Node APIs.
import type { HotelOffer } from '../types';

export const hotelKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

export const normaliseCity = (city: string): string => city.trim().replace(/\s+/g, ' ').toLowerCase();

// lower price, then higher commission, then Supplier A
export const isBetterOffer = (candidate: HotelOffer, current: HotelOffer): boolean => {
  if (candidate.price !== current.price) return candidate.price < current.price;
  if (candidate.commissionPct !== current.commissionPct) {
    return candidate.commissionPct > current.commissionPct;
  }
  return candidate.supplier === 'Supplier A' && current.supplier !== 'Supplier A';
};

export const compareOffers = (a: HotelOffer, b: HotelOffer): number =>
  a.price - b.price || hotelKey(a.name).localeCompare(hotelKey(b.name));

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
