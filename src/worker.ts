import { DefaultLogger, NativeConnection, Runtime, Worker, type LogLevel } from '@temporalio/worker';
import { config } from './config';
import { logger } from './logger';
import { createRedis } from './redis/client';
import { createHotelStore } from './redis/hotelStore';
import { createActivities } from './temporal/activities';
import { connectWithRetry } from './temporal/connection';

// route Temporal SDK logs through pino
const toPino: Record<LogLevel, 'trace' | 'debug' | 'info' | 'warn' | 'error'> = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

Runtime.install({
  logger: new DefaultLogger('INFO', ({ level, message, meta }) => {
    logger[toPino[level]](meta ?? {}, message);
  }),
});

async function main(): Promise<void> {
  const redis = createRedis();
  const store = createHotelStore(redis);

  const connection = await connectWithRetry('Temporal', () =>
    NativeConnection.connect({ address: config.TEMPORAL_ADDRESS }),
  );

  const worker = await Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    workflowsPath: require.resolve('./temporal/workflows'),
    activities: createActivities({
      store,
      supplierBaseUrl: config.SUPPLIER_BASE_URL,
      supplierTimeoutMs: config.SUPPLIER_TIMEOUT_MS,
      cacheTtlSeconds: config.CACHE_TTL_SECONDS,
      degradedTtlSeconds: config.DEGRADED_TTL_SECONDS,
    }),
  });

  logger.info(
    { taskQueue: config.TEMPORAL_TASK_QUEUE, namespace: config.TEMPORAL_NAMESPACE },
    'Worker started',
  );

  try {
    await worker.run();
  } finally {
    await connection.close();
    redis.disconnect();
    logger.info('Worker stopped');
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker crashed');
  process.exit(1);
});
