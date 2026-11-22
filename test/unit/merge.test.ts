import { describe, expect, it } from 'vitest';
import { hotelKey, mergeBestOffers, normaliseCity } from '../../src/domain/merge';
import { SUPPLIER_DATA } from '../../src/suppliers/data';
import { supplierLabel, type HotelOffer, type SupplierHotel, type SupplierId } from '../../src/types';

const offer = (
  name: string,
  price: number,
  supplier: 'A' | 'B',
  commissionPct = 10,
): HotelOffer => ({ name, price, supplier: `Supplier ${supplier}`, commissionPct });

const toOffers = (id: SupplierId, hotels: SupplierHotel[]): HotelOffer[] =>
  hotels.map((h) => ({ name: h.name, price: h.price, supplier: supplierLabel(id), commissionPct: h.commissionPct }));

describe('mergeBestOffers', () => {
  it('keeps the cheaper offer when both suppliers list a hotel', () => {
    const result = mergeBestOffers([offer('Holtin', 6000, 'A')], [offer('Holtin', 5340, 'B', 20)]);
    expect(result).toEqual([offer('Holtin', 5340, 'B', 20)]);
  });

  it('keeps hotels that only one supplier lists', () => {
    const result = mergeBestOffers([offer('Lemon Tree', 4200, 'A')], [offer('ITC Maurya', 11000, 'B')]);
    expect(result.map((h) => h.name)).toEqual(['Lemon Tree', 'ITC Maurya']);
  });

  it('breaks price ties by higher commission', () => {
    const result = mergeBestOffers([offer('Taj', 9500, 'A', 12)], [offer('Taj', 9500, 'B', 18)]);
    expect(result).toEqual([offer('Taj', 9500, 'B', 18)]);
  });

  it('breaks full ties in favour of Supplier A, regardless of input order', () => {
    const a = offer('Taj', 9500, 'A', 12);
    const b = offer('Taj', 9500, 'B', 12);
    expect(mergeBestOffers([a], [b])).toEqual([a]);
    expect(mergeBestOffers([b], [a])).toEqual([a]);
  });

  it('matches names case- and whitespace-insensitively but keeps the original spelling', () => {
    const result = mergeBestOffers([offer('  Holtin ', 6000, 'A')], [offer('HOLTIN', 5000, 'B')]);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('HOLTIN');
  });

  it('handles duplicates within a single supplier list', () => {
    const result = mergeBestOffers([offer('Holtin', 6000, 'A'), offer('Holtin', 5500, 'A')]);
    expect(result).toEqual([offer('Holtin', 5500, 'A')]);
  });

  it('returns results sorted by price ascending', () => {
    const result = mergeBestOffers(
      [offer('C', 300, 'A'), offer('A', 100, 'A')],
      [offer('B', 200, 'B')],
    );
    expect(result.map((h) => h.price)).toEqual([100, 200, 300]);
  });

  it('returns an empty list for empty inputs', () => {
    expect(mergeBestOffers()).toEqual([]);
    expect(mergeBestOffers([], [])).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const a = [offer('X', 2, 'A'), offer('Y', 1, 'A')];
    const snapshot = structuredClone(a);
    mergeBestOffers(a);
    expect(a).toEqual(snapshot);
  });
});

describe('mock data', () => {
  it('delhi has overlaps where each supplier wins at least once', () => {
    const a = toOffers('A', SUPPLIER_DATA.A.filter((h) => h.city === 'delhi'));
    const b = toOffers('B', SUPPLIER_DATA.B.filter((h) => h.city === 'delhi'));
    const overlap = a.filter((x) => b.some((y) => hotelKey(y.name) === hotelKey(x.name)));
    expect(overlap.length).toBeGreaterThanOrEqual(2);

    const merged = mergeBestOffers(a, b);
    const winners = new Set(
      merged.filter((m) => overlap.some((o) => hotelKey(o.name) === hotelKey(m.name))).map((m) => m.supplier),
    );
    expect(winners).toEqual(new Set(['Supplier A', 'Supplier B']));
  });

  it('delhi merges to the expected best offers', () => {
    const a = toOffers('A', SUPPLIER_DATA.A.filter((h) => h.city === 'delhi'));
    const b = toOffers('B', SUPPLIER_DATA.B.filter((h) => h.city === 'delhi'));
    expect(mergeBestOffers(a, b)).toEqual([
      { name: 'Lemon Tree', price: 4200, supplier: 'Supplier A', commissionPct: 8 },
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
      { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
      { name: 'Taj Palace', price: 9500, supplier: 'Supplier B', commissionPct: 18 },
      { name: 'ITC Maurya', price: 11000, supplier: 'Supplier B', commissionPct: 14 },
    ]);
  });
});

describe('normaliseCity', () => {
  it('trims, collapses spaces and lowercases', () => {
    expect(normaliseCity('  New   Delhi ')).toBe('new delhi');
  });
});
