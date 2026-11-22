import pino from 'pino';
import { config } from './config';

const service =
  process.env.SERVICE_NAME ?? (/worker\.[jt]s$/.test(require.main?.filename ?? '') ? 'worker' : 'api');

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['req.headers.authorization'],
  // Pretty output only for local development, JSON everywhere else.
  ...(config.NODE_ENV === 'development' && process.stdout.isTTY
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

export type Logger = typeof logger;
