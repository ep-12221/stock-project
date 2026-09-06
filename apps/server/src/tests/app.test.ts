import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

const fixture = mkdtempSync(join(tmpdir(), 'stock-static-test-'));
mkdirSync(join(fixture, 'assets'));
writeFileSync(join(fixture, 'index.html'), '<!doctype html><title>Stock fixture</title>');
writeFileSync(join(fixture, 'assets', 'app.js'), 'console.log("fixture");');
const app = createApp({ clientDistPath: fixture });

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe('HTTP skeleton', () => {
  it('returns a typed health response with a request ID', async () => {
    const response = await request(app).get('/api/health').expect(200);
    expect(response.body.data).toMatchObject({ status: 'ok', service: '@stock/server' });
    expect(Number.isNaN(Date.parse(response.body.data.serverTime))).toBe(false);
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('does not fall back to HTML for unknown API routes', async () => {
    const response = await request(app)
      .get('/api/unknown')
      .set('Accept', 'text/html')
      .expect('Content-Type', /json/)
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('serves built assets and browser routes', async () => {
    await request(app).get('/assets/app.js').expect(200).expect('console.log("fixture");');
    await request(app)
      .get('/orders/history')
      .set('Accept', 'text/html')
      .expect('Content-Type', /html/)
      .expect(200);
  });

  it('returns a 404 for missing assets, including extensionless assets', async () => {
    for (const path of ['/assets/missing.js', '/assets/missing', '/favicon.ico']) {
      await request(app).get(path).set('Accept', 'text/html').expect(404);
    }
  });

  it('reports absent frontend builds without crashing the health endpoint', async () => {
    const unbuilt = createApp({ clientDistPath: join(fixture, 'unbuilt') });
    await request(unbuilt).get('/').expect(503);
    await request(unbuilt).get('/api/health').expect(200);
  });

  it('returns a JSON validation error for malformed request bodies', async () => {
    const response = await request(app)
      .post('/api/orders')
      .set('Content-Type', 'application/json')
      .send('{"quantity":')
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires an upgrade on the WebSocket path instead of the SPA fallback', async () => {
    await request(app)
      .get('/ws')
      .set('Accept', 'text/html')
      .expect('Upgrade', 'websocket')
      .expect(426);
  });
});
