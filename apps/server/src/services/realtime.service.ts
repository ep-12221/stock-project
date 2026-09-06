import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { MarketSnapshot, RealtimeEvent } from '@stock/shared';
import WebSocket, { WebSocketServer } from 'ws';
import type { Session } from '../domain/models.js';
import { readSessionCookie } from '../middleware/auth.js';
import type { MemoryStore } from '../store/memory-store.js';
import { accountSnapshot } from './account.service.js';
import { createMarketService, marketSnapshot } from './market.service.js';
import type { SessionService } from './session.service.js';

export interface RealtimeOptions {
  store: MemoryStore;
  sessions: SessionService;
  allowedOrigins: readonly string[];
  random?: () => number;
  marketIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxBufferedBytes?: number;
}
interface Connection {
  session: Session;
  alive: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export function createRealtimeService(options: RealtimeOptions) {
  const { store, sessions } = options;
  const allowedOrigins = new Set(options.allowedOrigins);
  const marketIntervalMs = options.marketIntervalMs ?? 1_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const maxBufferedBytes = options.maxBufferedBytes ?? 1_048_576;
  for (const value of [marketIntervalMs, heartbeatIntervalMs, maxBufferedBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid realtime limit');
  }
  const market = createMarketService(store, options.random ? { random: options.random } : {});
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  });
  const connections = new Map<WebSocket, Connection>();
  const closingTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  let server: Server | undefined;
  let marketTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  function cleanup(socket: WebSocket) {
    const connection = connections.get(socket);
    if (connection) clearTimeout(connection.expiryTimer);
    connections.delete(socket);
    clearTimeout(closingTimers.get(socket));
    closingTimers.delete(socket);
  }
  function disconnect(socket: WebSocket, code?: number, reason = '') {
    cleanup(socket);
    if (socket.readyState === WebSocket.CLOSED) return;
    if (code === undefined) {
      socket.terminate();
      return;
    }
    try {
      socket.close(code, reason);
      // A client may never answer the close handshake. Bound shutdown and release its socket.
      const timer = setTimeout(() => {
        cleanup(socket);
        socket.terminate();
      }, 1_000);
      timer.unref();
      closingTimers.set(socket, timer);
    } catch {
      socket.terminate();
    }
  }
  function valid(socket: WebSocket): Connection | undefined {
    const connection = connections.get(socket);
    if (!connection || closed) return undefined;
    const session = sessions.resolve(connection.session.id);
    if (!session || session.userId !== connection.session.userId) {
      disconnect(socket, 4401, 'Session expired');
      return undefined;
    }
    return connection;
  }
  function send(socket: WebSocket, serialized: string) {
    if (!valid(socket)) return;
    if (
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount + Buffer.byteLength(serialized) > maxBufferedBytes
    ) {
      disconnect(socket);
      return;
    }
    try {
      socket.send(serialized, (error) => {
        if (error) disconnect(socket);
      });
    } catch {
      disconnect(socket);
    }
  }
  function serialize(event: RealtimeEvent): string {
    return JSON.stringify(event);
  }
  function envelope() {
    return { serverEpoch: store.serverEpoch, emittedAt: new Date(store.now()).toISOString() };
  }

  function scheduleExpiry(socket: WebSocket, connection: Connection) {
    clearTimeout(connection.expiryTimer);
    const remaining = connection.session.expiresAt - store.now();
    connection.expiryTimer = setTimeout(
      () => {
        if (valid(socket)) scheduleExpiry(socket, connection);
      },
      Math.max(1, Math.min(remaining, 2_147_483_647)),
    );
    connection.expiryTimer.unref();
  }
  const unsubscribe = sessions.onRevoke((session) => {
    for (const [socket, connection] of connections) {
      if (connection.session.id === session.id) disconnect(socket, 4401, 'Session expired');
    }
  });
  function publishMarket(snapshot: MarketSnapshot = marketSnapshot(store)) {
    if (closed) return;
    const serialized = serialize({ type: 'market.updated', ...envelope(), payload: snapshot });
    for (const socket of connections.keys()) send(socket, serialized);
  }
  function publishTrade(affectedUserIds: readonly string[]) {
    if (closed) return;
    publishMarket();
    const affected = new Set(affectedUserIds);
    const payloads = new Map<string, string>();
    for (const [socket, connection] of connections) {
      const userId = connection.session.userId;
      if (!affected.has(userId) || !valid(socket)) continue;
      let serialized = payloads.get(userId);
      if (!serialized) {
        serialized = serialize({
          type: 'account.updated',
          ...envelope(),
          payload: accountSnapshot(store, userId),
        });
        payloads.set(userId, serialized);
      }
      send(socket, serialized);
    }
  }
  function heartbeat() {
    if (closed) return;
    sessions.pruneExpired();
    for (const [socket, connection] of connections) {
      if (!valid(socket)) continue;
      if (!connection.alive || socket.bufferedAmount > maxBufferedBytes) {
        disconnect(socket);
        continue;
      }
      connection.alive = false;
      try {
        socket.ping(undefined, undefined, (error) => {
          if (error) disconnect(socket);
        });
      } catch {
        disconnect(socket);
      }
    }
  }
  function rejectUpgrade(socket: Duplex, status: number) {
    const message =
      status === 401
        ? 'Unauthorized'
        : status === 403
          ? 'Forbidden'
          : status === 404
            ? 'Not Found'
            : 'Service Unavailable';
    socket.end(
      'HTTP/1.1 ' + status + ' ' + message + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      () => socket.destroy(),
    );
  }
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const onRawError = () => socket.destroy();
    socket.on('error', onRawError);
    if (closed) {
      rejectUpgrade(socket, 503);
      return;
    }
    if (req.url?.split('?')[0] !== '/ws') {
      rejectUpgrade(socket, 404);
      return;
    }
    if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) {
      rejectUpgrade(socket, 403);
      return;
    }
    const session = sessions.resolve(readSessionCookie(req));
    if (!session) {
      rejectUpgrade(socket, 401);
      return;
    }
    // resolve, registration and the initial snapshot run in the same synchronous upgrade turn.
    webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      socket.removeListener('error', onRawError);
      ws.on('error', () => disconnect(ws));
      ws.on('close', () => cleanup(ws));
      const connection: Connection = { session, alive: true };
      connections.set(ws, connection);
      ws.on('pong', () => {
        connection.alive = true;
      });
      // This channel only publishes snapshots. Orders continue through authenticated HTTP.
      ws.on('message', () => disconnect(ws, 1008, 'Client messages are unsupported'));
      scheduleExpiry(ws, connection);
      send(
        ws,
        serialize({
          type: 'state.snapshot',
          ...envelope(),
          payload: {
            market: marketSnapshot(store),
            account: accountSnapshot(store, session.userId),
          },
        }),
      );
    });
  }
  function attach(httpServer: Server) {
    if (closed || server) throw new Error('Realtime service can only attach once');
    server = httpServer;
    server.on('upgrade', upgrade);
    server.once('close', close);
    marketTimer = setInterval(() => {
      // A publication error must never stop the HTTP service or change transaction outcomes.
      try {
        publishMarket(market.tick());
      } catch {
        /* Retry a fresh complete snapshot next tick. */
      }
    }, marketIntervalMs);
    heartbeatTimer = setInterval(heartbeat, heartbeatIntervalMs);
    marketTimer.unref();
    heartbeatTimer.unref();
  }
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(marketTimer);
    clearInterval(heartbeatTimer);
    unsubscribe();
    server?.removeListener('upgrade', upgrade);
    server?.removeListener('close', close);
    for (const socket of closingTimers.keys()) disconnect(socket);
    for (const socket of connections.keys()) disconnect(socket, 1001, 'Server shutting down');
    webSocketServer.close();
  }
  return {
    attach,
    close,
    publishTrade,
    publishMarket,
    heartbeat,
    webSocketServer,
    get connectionCount() {
      return connections.size;
    },
  };
}
