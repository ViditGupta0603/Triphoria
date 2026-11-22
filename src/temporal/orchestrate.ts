/**
 * Orchestration core used by the Temporal workflow.
 *
 * Kept free of Temporal imports and I/O so it can run inside the workflow
 * sandbox and be unit-tested with plain stubs.
 */
import { mergeBestOffers, normaliseCity } from '../domain/merge';
import {
  SUPPLIER_IDS,
  type HotelOffer,
  type HotelOffersWorkflowResult,
  type SupplierId,
} from '../types';

export interface OrchestratorLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface OrchestratorDeps {
  fetchSupplierHotels(supplier: SupplierId, city: string): Promise<HotelOffer[]>;
  cacheHotels(city: string, hotels: HotelOffer[], degradedSuppliers: SupplierId[]): Promise<void>;
  /** Builds the error thrown when every supplier failed. */
  allSuppliersFailed(message: string, failures: SupplierFailure[]): Error;
  log: OrchestratorLog;
}

export interface SupplierFailure {
  supplier: SupplierId;
  error: string;
}

const describeError = (reason: unknown): string => {
  if (reason instanceof Error) {
    // Temporal wraps activity errors: ActivityFailure.cause holds the real one.
    const cause = (reason as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : reason.message;
  }
  return String(reason);
};

export async function collectBestOffers(
  rawCity: string,
  deps: OrchestratorDeps,
): Promise<HotelOffersWorkflowResult> {
  const city = normaliseCity(rawCity);
  deps.log.info('Fetching offers from suppliers', { city, suppliers: SUPPLIER_IDS });

  // Fan out to every supplier in parallel; one failure must not cancel the others.
  const settled = await Promise.allSettled(
    SUPPLIER_IDS.map((supplier) => deps.fetchSupplierHotels(supplier, city)),
  );

  const lists: HotelOffer[][] = [];
  const failures: SupplierFailure[] = [];

  settled.forEach((result, i) => {
    const supplier = SUPPLIER_IDS[i] as SupplierId;
    if (result.status === 'fulfilled') {
      lists.push(result.value);
      deps.log.info('Supplier responded', { city, supplier, count: result.value.length });
    } else {
      const error = describeError(result.reason);
      failures.push({ supplier, error });
      deps.log.warn('Supplier failed after retries; continuing without it', { city, supplier, error });
    }
  });

  if (lists.length === 0) {
    deps.log.error('All suppliers failed', { city, failures });
    throw deps.allSuppliersFailed('All suppliers unavailable', failures);
  }

  const hotels = mergeBestOffers(...lists);
  const degradedSuppliers = failures.map((f) => f.supplier);

  await deps.cacheHotels(city, hotels, degradedSuppliers);

  deps.log.info('Best offers selected and cached', {
    city,
    count: hotels.length,
    degradedSuppliers,
  });

  return { city, hotels, degradedSuppliers };
}
