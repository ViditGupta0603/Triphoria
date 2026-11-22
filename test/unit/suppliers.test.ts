import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createSupplierRouter, setSupplierUp } from '../../src/suppliers/router';

const app = express();
app.use(express.json());
app.use('/supplierA', createSupplierRouter('A'));
app.use('/supplierB', createSupplierRouter('B'));

afterEach(() => {
  setSupplierUp('A', true);
  setSupplierUp('B', true);
});

describe('mock supplier API', () => {
  it('returns hotels for a city, case-insensitively', async () => {
    const res = await request(app).get('/supplierA/hotels?city=DELHI');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(res.body[0]).toMatchObject({ hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi' });
  });

  it('returns an empty array for an unknown city', async () => {
    const res = await request(app).get('/supplierB/hotels?city=atlantis');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all hotels when no city is given', async () => {
    const res = await request(app).get('/supplierB/hotels');
    expect(res.body.length).toBeGreaterThan(4);
  });

  it('returns 503 when switched down and recovers when switched up', async () => {
    let res = await request(app).post('/supplierB/status').send({ up: false });
    expect(res.body).toEqual({ supplier: 'Supplier B', up: false });

    res = await request(app).get('/supplierB/hotels?city=delhi');
    expect(res.status).toBe(503);

    // Supplier A is unaffected.
    res = await request(app).get('/supplierA/hotels?city=delhi');
    expect(res.status).toBe(200);

    await request(app).post('/supplierB/status').send({ up: true });
    res = await request(app).get('/supplierB/hotels?city=delhi');
    expect(res.status).toBe(200);
  });

  it('rejects an invalid status body', async () => {
    const res = await request(app).post('/supplierA/status').send({ up: 'no' });
    expect(res.status).toBe(400);
  });
});
