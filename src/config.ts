import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  DEGRADED_TTL_SECONDS: z.coerce.number().int().positive().default(30),

  TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
  TEMPORAL_TASK_QUEUE: z.string().default('hotel-offers'),
  WORKFLOW_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  SUPPLIER_BASE_URL: z.string().url().default('http://localhost:3000'),
  SUPPLIER_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  SUPPLIER_A_DOWN: bool,
  SUPPLIER_B_DOWN: bool,
});

export type Config = z.infer<typeof schema>;

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable message; logger may not be configured yet.
  console.error('Invalid environment configuration:', z.prettifyError(parsed.error));
  process.exit(1);
}

export const config: Config = parsed.data;
