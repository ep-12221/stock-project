import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { StocksDto, RealtimeEvent } from '@stock/shared';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { readConfig } from '../config.js';

const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));

it.each(
  (['array', 'price-tree'] as const).flatMap((engine) =>
    [undefined, 'true', 'false'].map((flag) => ({ engine, flag })),
  ),
)(
  'honors MATCHING_ENGINE=$engine and ENABLE_DEMO_LIQUIDITY=$flag through startup',
  async ({ engine, flag }) => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      MATCHING_ENGINE: engine,
      ALLOWED_ORIGINS: 'http://localhost:5173',
      COOKIE_SECURE: 'false',
      SESSION_TTL_MS: '60000',
    };
    // Pin the parsed default too, so a local .env cannot change this isolated test.
    env.ENABLE_DEMO_LIQUIDITY = flag ?? String(readConfig({}).ENABLE_DEMO_LIQUIDITY);
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    let output = '';
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error('Startup timed out: ' + output)), 5_000);
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Startup exited: ' + output)));
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('Stock server listening')) resolve();
        });
      }).finally(() => clearTimeout(startupTimer));
      expect(output).toContain('(matching: ' + engine + ')');
      const base = 'http://127.0.0.1:' + port;
      const registration = await fetch(base + '/api/auth/register', {
        method: 'POST',
        headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'seedcheck', password: 'startup-test-password' }),
        signal: AbortSignal.timeout(3_000),
      });
      expect(registration.status).toBe(201);
      const cookie = registration.headers.getSetCookie()[0]!.split(';')[0]!;
      const response = await fetch(base + '/api/stocks', {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(3_000),
      });
      expect(response.status).toBe(200);
      const market: StocksDto = (await response.json()).data;
      const enabled = flag !== 'false';
      // The single market timer may tick while registration hashes the password.
      expect(market.marketVersion).toBeGreaterThanOrEqual(enabled ? 6 : 0);
      expect(market.quotes).toHaveLength(3);
      for (const quote of market.quotes) {
        expect(quote.bestBidCents).toBe(enabled ? quote.previousCloseCents - 1 : null);
        expect(quote.bestAskCents).toBe(enabled ? quote.previousCloseCents + 1 : null);
      }
      socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', {
        origin: 'http://localhost:5173',
        headers: { Cookie: cookie },
      });
      socket.on('error', () => undefined);
      const initialFrame = once(socket, 'message', { signal: AbortSignal.timeout(3_000) });
      const first = JSON.parse((await initialFrame)[0].toString()) as RealtimeEvent;
      expect(first).toMatchObject({
        type: 'state.snapshot',
        payload: {
          account: { accountVersion: 0 },
          market: { quotes: expect.any(Array) },
        },
      });
      const privateUpdate = new Promise<RealtimeEvent>((resolve, reject) => {
        updateTimer = setTimeout(
          () => reject(new Error('No account update from actual startup')),
          3_000,
        );
        const onMessage = (data: import('ws').RawData) => {
          const event = JSON.parse(data.toString()) as RealtimeEvent;
          if (event.type !== 'account.updated') return;
          clearTimeout(updateTimer);
          socket!.off('message', onMessage);
          resolve(event);
        };
        socket!.on('message', onMessage);
      });
      const order = await fetch(base + '/api/orders', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'http://localhost:5173',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientOrderId: randomUUID(),
          symbol: 'SIM001',
          side: 'BUY',
          priceCents: 1001,
          quantity: 1,
        }),
        signal: AbortSignal.timeout(3_000),
      });
      expect(order.status).toBe(201);
      expect((await order.json()).data.order.status).toBe(enabled ? 'FILLED' : 'OPEN');
      expect(await privateUpdate).toMatchObject({
        type: 'account.updated',
        payload: { accountVersion: 1 },
      });
    } finally {
      clearTimeout(updateTimer);
      const socketClosed =
        socket?.readyState === WebSocket.OPEN ? once(socket, 'close') : undefined;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      try {
        const [exitCode] = await closed;
        expect(exitCode).toBe(0);
        if (socketClosed) expect((await socketClosed)[0]).toBe(1001);
      } finally {
        clearTimeout(killTimer);
        socket?.terminate();
      }
    }
  },
  15_000,
);
