import { httpSupplierCheck } from './api/health';
import { createApp } from './app';
import { config } from './config';
import { logger } from './logger';
import { createRedis } from './redis/client';
import { createHotelStore } from './redis/hotelStore';
import { checkTemporal, closeTemporalClient, getTemporalClient, temporalRunner } from './temporal/client';

const redis = createRedis();
const store = createHotelStore(redis);

const app = createApp({
  hotels: {
    runner: temporalRunner,
    store,
    workflowTimeoutMs: config.WORKFLOW_TIMEOUT_MS,
  },
  health: {
    checkSupplier: httpSupplierCheck(config.SUPPLIER_BASE_URL),
    checkRedis: async () => {
      if (!(await store.ping())) throw new Error('PING failed');
    },
    checkTemporal,
    timeoutMs: 2_000,
  },
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'API listening');
});

// connect early so the first request doesn't wait for it
getTemporalClient().catch((err: unknown) =>
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Could not connect to Temporal'),
);

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down API');

  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();

  server.close(async () => {
    await Promise.allSettled([redis.quit(), closeTemporalClient()]);
    logger.info('API stopped');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
