/**
 * Local harness for running the Postman collection without a Temporal server.
 *
 * Uses the real Express app, the real activities (HTTP calls to the mock
 * suppliers), the real orchestration logic and a real Redis. Only Temporal's
 * scheduling is replaced by direct calls, so there are no activity retries.
 *
 *   REDIS_URL=redis://localhost:6379 npx tsx test/e2e/local-harness.ts
 *   npx newman run postman/Triphoria.postman_collection.json --env-var baseUrl=http://localhost:3100
 *
 * For the real end-to-end run use `docker compose up --build` instead.
 */
import { httpSupplierCheck } from '../../src/api/health';
import { createApp } from '../../src/app';
import { logger } from '../../src/logger';
import { createRedis } from '../../src/redis/client';
import { createHotelStore } from '../../src/redis/hotelStore';
import { createActivities } from '../../src/temporal/activities';
import type { HotelOffersRunner } from '../../src/temporal/client';
import { collectBestOffers } from '../../src/temporal/orchestrate';
import { ApplicationFailure } from '@temporalio/common';
import { WorkflowFailedError } from '@temporalio/client';
import { ALL_SUPPLIERS_FAILED } from '../../src/temporal/constants';

const port = Number(process.env.HARNESS_PORT ?? 3100);
const baseUrl = `http://localhost:${port}`;

const redis = createRedis();
const store = createHotelStore(redis);
const activities = createActivities({
  store,
  supplierBaseUrl: baseUrl,
  supplierTimeoutMs: 2_000,
  cacheTtlSeconds: 300,
  degradedTtlSeconds: 30,
});

const runner: HotelOffersRunner = {
  async run(city) {
    try {
      return await collectBestOffers(city, {
        ...activities,
        allSuppliersFailed: (message, failures) =>
          ApplicationFailure.nonRetryable(message, ALL_SUPPLIERS_FAILED, { failures }),
        log: {
          info: (m, meta) => logger.info(meta ?? {}, m),
          warn: (m, meta) => logger.warn(meta ?? {}, m),
          error: (m, meta) => logger.error(meta ?? {}, m),
        },
      });
    } catch (err) {
      // Mirror how Temporal surfaces workflow failures to the client.
      if (err instanceof ApplicationFailure) {
        throw new WorkflowFailedError('Workflow execution failed', err, 'NON_RETRYABLE_FAILURE');
      }
      throw err;
    }
  },
};

const app = createApp({
  hotels: { runner, store, workflowTimeoutMs: 10_000 },
  health: {
    checkSupplier: httpSupplierCheck(baseUrl),
    checkRedis: async () => {
      if (!(await store.ping())) throw new Error('PING failed');
    },
    checkTemporal: async () => {}, // no Temporal in the harness
    timeoutMs: 2_000,
  },
});

app.listen(port, () => logger.info({ port }, 'Local harness listening'));
