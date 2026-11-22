import { describe, expect, it, vi } from 'vitest';
import { collectBestOffers, type OrchestratorDeps } from '../../src/temporal/orchestrate';
import type { HotelOffer, SupplierId } from '../../src/types';

const A: HotelOffer[] = [
  { name: 'Holtin', price: 6000, supplier: 'Supplier A', commissionPct: 10 },
  { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
];
const B: HotelOffer[] = [
  { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
  { name: 'Radison', price: 6100, supplier: 'Supplier B', commissionPct: 15 },
];

class AllFailed extends Error {
  constructor(message: string, public failures: unknown) {
    super(message);
  }
}

const makeDeps = (behaviour: Record<SupplierId, HotelOffer[] | Error>) => {
  const deps: OrchestratorDeps = {
    fetchSupplierHotels: vi.fn(async (supplier: SupplierId) => {
      const r = behaviour[supplier];
      if (r instanceof Error) throw r;
      return r;
    }),
    cacheHotels: vi.fn(async () => {}),
    allSuppliersFailed: (message, failures) => new AllFailed(message, failures),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return deps;
};

describe('collectBestOffers', () => {
  it('calls both suppliers in parallel, merges, caches and returns', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const deps = makeDeps({ A, B });
    deps.fetchSupplierHotels = vi.fn(async (supplier: SupplierId) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return supplier === 'A' ? A : B;
    });

    const result = await collectBestOffers('  Delhi ', deps);

    expect(maxInFlight).toBe(2);
    expect(deps.fetchSupplierHotels).toHaveBeenCalledWith('A', 'delhi');
    expect(deps.fetchSupplierHotels).toHaveBeenCalledWith('B', 'delhi');
    expect(result).toEqual({
      city: 'delhi',
      degradedSuppliers: [],
      hotels: [
        { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
        { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
      ],
    });
    expect(deps.cacheHotels).toHaveBeenCalledWith('delhi', result.hotels, []);
  });

  it('returns partial results and flags the failed supplier', async () => {
    const deps = makeDeps({ A, B: new Error('HTTP 503') });
    const result = await collectBestOffers('delhi', deps);

    expect(result.hotels).toEqual([...A].sort((x, y) => x.price - y.price));
    expect(result.degradedSuppliers).toEqual(['B']);
    expect(deps.cacheHotels).toHaveBeenCalledWith('delhi', result.hotels, ['B']);
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Supplier failed'),
      expect.objectContaining({ supplier: 'B', error: 'HTTP 503' }),
    );
  });

  it('reports the underlying cause of a wrapped activity failure', async () => {
    const wrapped = Object.assign(new Error('Activity task failed'), { cause: new Error('HTTP 503') });
    const deps = makeDeps({ A: wrapped, B });
    await collectBestOffers('delhi', deps);
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ supplier: 'A', error: 'HTTP 503' }),
    );
  });

  it('throws and does not cache when every supplier fails', async () => {
    const deps = makeDeps({ A: new Error('down'), B: new Error('down') });
    await expect(collectBestOffers('delhi', deps)).rejects.toBeInstanceOf(AllFailed);
    expect(deps.cacheHotels).not.toHaveBeenCalled();
  });

  it('caches and returns an empty list when suppliers have no hotels', async () => {
    const deps = makeDeps({ A: [], B: [] });
    const result = await collectBestOffers('atlantis', deps);
    expect(result.hotels).toEqual([]);
    expect(deps.cacheHotels).toHaveBeenCalledWith('atlantis', [], []);
  });

  it('propagates cache failures', async () => {
    const deps = makeDeps({ A, B });
    deps.cacheHotels = vi.fn(async () => {
      throw new Error('redis down');
    });
    await expect(collectBestOffers('delhi', deps)).rejects.toThrow('redis down');
  });
});
