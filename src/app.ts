import express, { type Express } from 'express';
import { errorHandler, notFound } from './api/errors';
import { createHealthRouter, type HealthDeps } from './api/health';
import { createHotelsRouter, type HotelsRouterDeps } from './api/hotels';
import { requestContext } from './api/requestContext';
import { createSupplierRouter } from './suppliers/router';

export interface AppDeps {
  hotels: HotelsRouterDeps;
  health: HealthDeps;
}

export const createApp = (deps: AppDeps): Express => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(requestContext);
  app.use(express.json({ limit: '10kb' }));

  app.get('/', (_req, res) => {
    res.json({
      service: 'hotel-offer-orchestrator',
      endpoints: [
        'GET /api/hotels?city=delhi',
        'GET /api/hotels?city=delhi&minPrice=5000&maxPrice=10000',
        'GET /health',
        'GET /supplierA/hotels?city=delhi',
        'GET /supplierB/hotels?city=delhi',
        'POST /supplierA/status {"up": false}',
        'POST /supplierB/status {"up": false}',
      ],
    });
  });

  // Liveness probe for container orchestration: the process is up and serving.
  // (/health reports dependency and supplier health and may return 503.)
  app.get('/livez', (_req, res) => {
    res.json({ status: 'alive' });
  });

  app.use('/api/hotels', createHotelsRouter(deps.hotels));
  app.use('/health', createHealthRouter(deps.health));
  app.use('/supplierA', createSupplierRouter('A'));
  app.use('/supplierB', createSupplierRouter('B'));

  app.use(notFound);
  app.use(errorHandler);

  return app;
};
