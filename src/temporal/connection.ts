import { logger } from '../logger';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Temporal can take a few seconds to accept connections after the container starts
export async function connectWithRetry<T>(
  what: string,
  connect: () => Promise<T>,
  { attempts = 30, initialDelayMs = 500, maxDelayMs = 5_000 } = {},
): Promise<T> {
  let delay = initialDelayMs;
  for (let i = 1; ; i++) {
    try {
      return await connect();
    } catch (err) {
      if (i >= attempts) throw err;
      logger.warn({ attempt: i, err: err instanceof Error ? err.message : String(err) }, `${what} not ready, retrying`);
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}
