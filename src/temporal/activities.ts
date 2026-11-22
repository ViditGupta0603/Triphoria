import { Context, log as temporalLog } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { z } from 'zod';
import { normaliseCity } from '../domain/merge';
import { logger } from '../logger';
import type { HotelStore } from '../redis/hotelStore';
import { supplierLabel, type HotelOffer, type SupplierId } from '../types';
import { INVALID_SUPPLIER_RESPONSE, SUPPLIER_CLIENT_ERROR, SUPPLIER_UNAVAILABLE } from './constants';

const supplierHotelSchema = z.object({
  hotelId: z.string().min(1),
  name: z.string().trim().min(1),
  price: z.number().finite().nonnegative(),
  city: z.string().min(1),
  commissionPct: z.number().finite().min(0).max(100),
});

const supplierResponseSchema = z.array(supplierHotelSchema);

export interface ActivityDeps {
  store: HotelStore;
  supplierBaseUrl: string;
  supplierTimeoutMs: number;
  cacheTtlSeconds: number;
  degradedTtlSeconds: number;
  fetchImpl?: typeof fetch;
}

type Level = 'info' | 'warn' | 'error';

/**
 * Temporal's activity logger (adds workflow/activity ids) when running inside
 * a worker; falls back to the app logger when called outside an activity.
 */
const emit = (level: Level, message: string, meta?: Record<string, unknown>): void => {
  try {
    Context.current();
  } catch {
    logger[level](meta ?? {}, message);
    return;
  }
  temporalLog[level](message, meta);
};

const log = {
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
};

const attempt = (): number => {
  try {
    return Context.current().info.attempt;
  } catch {
    return 1; // called outside an activity (e.g. tests)
  }
};

const cancellationSignal = (): AbortSignal | undefined => {
  try {
    return Context.current().cancellationSignal;
  } catch {
    return undefined;
  }
};

export const createActivities = (deps: ActivityDeps) => {
  const doFetch = deps.fetchImpl ?? fetch;

  return {
    /** Fetches one supplier's hotels for a city and maps them to offers. */
    async fetchSupplierHotels(supplier: SupplierId, city: string): Promise<HotelOffer[]> {
      const label = supplierLabel(supplier);
      const url = new URL(`/supplier${supplier}/hotels`, deps.supplierBaseUrl);
      url.searchParams.set('city', city);
      const started = Date.now();
      log.info('Calling supplier', { supplier: label, city, attempt: attempt() });

      const signals = [AbortSignal.timeout(deps.supplierTimeoutMs)];
      const cancel = cancellationSignal();
      if (cancel) signals.push(cancel);

      let res: Response;
      try {
        res = await doFetch(url, { signal: AbortSignal.any(signals), headers: { accept: 'application/json' } });
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        log.warn('Supplier request failed', { supplier: label, city, attempt: attempt(), error: message });
        throw ApplicationFailure.retryable(`${label} request failed: ${message}`, SUPPLIER_UNAVAILABLE);
      }

      if (!res.ok) {
        const message = `${label} responded with HTTP ${res.status}`;
        log.warn('Supplier returned an error status', { supplier: label, city, status: res.status, attempt: attempt() });
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          throw ApplicationFailure.nonRetryable(message, SUPPLIER_CLIENT_ERROR);
        }
        throw ApplicationFailure.retryable(message, SUPPLIER_UNAVAILABLE);
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw ApplicationFailure.nonRetryable(`${label} returned invalid JSON`, INVALID_SUPPLIER_RESPONSE);
      }

      const parsed = supplierResponseSchema.safeParse(body);
      if (!parsed.success) {
        log.error('Supplier response failed validation', { supplier: label, issues: parsed.error.issues.slice(0, 5) });
        throw ApplicationFailure.nonRetryable(`${label} returned an unexpected payload`, INVALID_SUPPLIER_RESPONSE);
      }

      const wanted = normaliseCity(city);
      const offers: HotelOffer[] = parsed.data
        .filter((h) => normaliseCity(h.city) === wanted) // defend against suppliers ignoring the filter
        .map((h) => ({ name: h.name, price: h.price, supplier: label, commissionPct: h.commissionPct }));

      log.info('Supplier call succeeded', {
        supplier: label,
        city,
        count: offers.length,
        durationMs: Date.now() - started,
      });
      return offers;
    },

    /** Stores the de-duplicated list for a city in Redis. */
    async cacheHotels(city: string, hotels: HotelOffer[], degradedSuppliers: SupplierId[]): Promise<void> {
      const ttlSeconds = degradedSuppliers.length > 0 ? deps.degradedTtlSeconds : deps.cacheTtlSeconds;
      try {
        await deps.store.saveCity(city, hotels, { ttlSeconds, degradedSuppliers });
      } catch (err) {
        log.error('Failed to cache hotels in Redis', {
          city,
          attempt: attempt(),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      log.info('Cached hotels in Redis', { city, count: hotels.length, ttlSeconds });
    },
  };
};

export type Activities = ReturnType<typeof createActivities>;
