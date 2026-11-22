import { Router } from 'express';
import { SUPPLIER_IDS, type SupplierId } from '../types';

export interface ComponentStatus {
  status: 'up' | 'down';
  latencyMs?: number;
  error?: string;
}

export interface HealthDeps {
  checkSupplier(id: SupplierId): Promise<void>;
  checkRedis(): Promise<void>;
  checkTemporal(): Promise<void>;
  timeoutMs: number;
}

const probe = async (check: () => Promise<void>, timeoutMs: number): Promise<ComponentStatus> => {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { status: 'up', latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
};

/** Supplier probe that calls the supplier's real hotels endpoint over HTTP. */
export const httpSupplierCheck =
  (baseUrl: string, fetchImpl: typeof fetch = fetch) =>
  async (id: SupplierId): Promise<void> => {
    const res = await fetchImpl(new URL(`/supplier${id}/hotels`, baseUrl), {
      headers: { accept: 'application/json' },
    });
    // Drain the body so the connection can be reused.
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };

export const createHealthRouter = (deps: HealthDeps): Router => {
  const router = Router();

  router.get('/', async (_req, res) => {
    const [supplierA, supplierB, redis, temporal] = await Promise.all([
      ...SUPPLIER_IDS.map((id) => probe(() => deps.checkSupplier(id), deps.timeoutMs)),
      probe(deps.checkRedis, deps.timeoutMs),
      probe(deps.checkTemporal, deps.timeoutMs),
    ]);

    const components = [supplierA, supplierB, redis, temporal] as ComponentStatus[];
    const healthy = components.every((c) => c.status === 'up');

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      suppliers: { supplierA, supplierB },
      dependencies: { redis, temporal },
    });
  });

  return router;
};
