import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { normaliseCity } from '../domain/merge';
import { logger } from '../logger';
import { supplierLabel, type SupplierHotel, type SupplierId } from '../types';
import { SUPPLIER_DATA } from './data';

/** In-memory outage switch per mock supplier (used to simulate downtime). */
const supplierUp: Record<SupplierId, boolean> = {
  A: !config.SUPPLIER_A_DOWN,
  B: !config.SUPPLIER_B_DOWN,
};

export const isSupplierUp = (id: SupplierId): boolean => supplierUp[id];

export const setSupplierUp = (id: SupplierId, up: boolean): void => {
  supplierUp[id] = up;
};

export const getSupplierHotels = (id: SupplierId, city?: string): SupplierHotel[] => {
  const all = SUPPLIER_DATA[id];
  if (!city) return all;
  const wanted = normaliseCity(city);
  return all.filter((h) => normaliseCity(h.city) === wanted);
};

const statusBody = z.object({ up: z.boolean() });

/** Router mounted at /supplierA or /supplierB. */
export const createSupplierRouter = (id: SupplierId): Router => {
  const router = Router();
  const label = supplierLabel(id);

  router.get('/hotels', (req, res) => {
    if (!supplierUp[id]) {
      res.status(503).json({ error: `${label} is unavailable` });
      return;
    }
    const city = typeof req.query.city === 'string' ? req.query.city : undefined;
    res.json(getSupplierHotels(id, city));
  });

  router.get('/status', (_req, res) => {
    res.json({ supplier: label, up: supplierUp[id] });
  });

  router.post('/status', (req, res) => {
    const parsed = statusBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Body must be {"up": boolean}' });
      return;
    }
    setSupplierUp(id, parsed.data.up);
    logger.warn({ supplier: label, up: parsed.data.up }, 'Mock supplier status changed');
    res.json({ supplier: label, up: supplierUp[id] });
  });

  return router;
};
