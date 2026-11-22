import { Redis } from 'ioredis';
import { config } from '../config';
import { logger } from '../logger';

export const createRedis = (url: string = config.REDIS_URL): Redis => {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
    lazyConnect: false,
  });

  redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis connection error'));
  redis.on('ready', () => logger.info({ url: url.replace(/\/\/.*@/, '//***@') }, 'Redis ready'));

  return redis;
};
