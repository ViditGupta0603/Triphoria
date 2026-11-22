import { ApplicationFailure } from '@temporalio/common';
import { WorkflowFailedError } from '@temporalio/client';
import { Router } from 'express';
import { z } from 'zod';
import { normaliseCity } from '../domain/merge';
import type { Logger } from '../logger';
import type { HotelStore, PriceRange } from '../redis/hotelStore';
import type { HotelOffersRunner } from '../temporal/client';
import { ALL_SUPPLIERS_FAILED } from '../temporal/constants';
import { supplierLabel, type HotelOffersWorkflowResult, type SupplierId } from '../types';
import { DependencyError, HttpError, UpstreamError, ValidationError } from './errors';

const price = (field: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, `${field} must be a non-negative number`)
    .transform(Number)
    .optional();

export const hotelsQuerySchema = z
  .object({
    city: z
      .string({ error: 'city is required' })
      .trim()
      .min(1, 'city is required')
      .max(64, 'city is too long')
      .regex(/^[\p{L}][\p{L} .'-]*$/u, 'city may only contain letters, spaces, dots, apostrophes and hyphens'),
    minPrice: price('minPrice'),
    maxPrice: price('maxPrice'),
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    message: 'minPrice must be less than or equal to maxPrice',
    path: ['minPrice'],
  });

export type HotelsQuery = z.infer<typeof hotelsQuerySchema>;

export interface HotelsRouterDeps {
  runner: HotelOffersRunner;
  store: HotelStore;
  workflowTimeoutMs: number;
}

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DependencyError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/** Maps workflow / Temporal errors to HTTP errors. */
export const toHttpError = (err: unknown): HttpError => {
  if (err instanceof HttpError) return err;

  if (err instanceof WorkflowFailedError) {
    const cause = err.cause;
    if (cause instanceof ApplicationFailure && cause.type === ALL_SUPPLIERS_FAILED) {
      const [details] = (cause.details ?? []) as [{ failures?: unknown } | undefined];
      return new UpstreamError('All suppliers unavailable', details?.failures);
    }
    return new DependencyError('Hotel aggregation workflow failed', cause?.message ?? err.message);
  }

  return new DependencyError('Orchestration service unavailable', err instanceof Error ? err.message : String(err));
};

const degradedHeader = (ids: SupplierId[]): string => ids.map(supplierLabel).join(', ');

export const createHotelsRouter = ({ runner, store, workflowTimeoutMs }: HotelsRouterDeps): Router => {
  const router = Router();

  const runWorkflow = async (city: string, requestId: string, log: Logger): Promise<HotelOffersWorkflowResult> => {
    try {
      const result = await withTimeout(
        runner.run(city, requestId),
        workflowTimeoutMs,
        'Timed out waiting for hotel aggregation',
      );
      log.info({ city, count: result.hotels.length, degraded: result.degradedSuppliers }, 'Workflow completed');
      return result;
    } catch (err) {
      throw toHttpError(err);
    }
  };

  const filterInRedis = async (city: string, range: PriceRange) => {
    try {
      return await store.filterByPrice(city, range);
    } catch (err) {
      throw new DependencyError('Cache unavailable', err instanceof Error ? err.message : String(err));
    }
  };

  router.get('/', async (req, res) => {
    const parsed = hotelsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(
        'Invalid query parameters',
        parsed.error.issues.map((i) => ({ field: i.path.join('.') || 'query', message: i.message })),
      );
    }

    const { minPrice, maxPrice } = parsed.data;
    const city = normaliseCity(parsed.data.city);
    const requestId = res.locals.requestId as string;
    const log = res.locals.log as Logger;

    // Unfiltered: always run the workflow (fresh data, refreshes the cache).
    if (minPrice === undefined && maxPrice === undefined) {
      const result = await runWorkflow(city, requestId, log);
      if (result.degradedSuppliers.length > 0) {
        res.setHeader('X-Degraded-Suppliers', degradedHeader(result.degradedSuppliers));
      }
      res.json(result.hotels);
      return;
    }

    // Filtered: price range query runs inside Redis; fill the cache first on a miss.
    const range: PriceRange = { minPrice, maxPrice };
    let cacheStatus: 'HIT' | 'MISS' = 'HIT';
    let cached = await filterInRedis(city, range);

    if (cached === null) {
      cacheStatus = 'MISS';
      await runWorkflow(city, requestId, log);
      cached = await filterInRedis(city, range);
      if (cached === null) throw new DependencyError('Cache was not populated');
    }

    res.setHeader('X-Cache', cacheStatus);
    if (cached.degradedSuppliers.length > 0) {
      res.setHeader('X-Degraded-Suppliers', degradedHeader(cached.degradedSuppliers));
    }
    res.json(cached.hotels);
  });

  return router;
};
