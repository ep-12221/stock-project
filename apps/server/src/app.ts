import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { errorHandler, sendError } from './middleware/error.js';
import { createHealthRouter } from './routes/health.js';
import { createMemoryStore } from './store/memory-store.js';
import type { MemoryStore } from './store/memory-store.js';
import { createSessionService } from './services/session.service.js';
import type { SessionService } from './services/session.service.js';
import { createAuthRouter } from './routes/auth.js';
import { createAccountRouter } from './routes/account.js';
import { readConfig } from './config.js';
import { createTradingRouter } from './routes/trading.js';
import type { TradingOptions } from './services/trading.service.js';

export interface AppOptions {
  clientDistPath?: string;
  store?: MemoryStore;
  sessions?: SessionService;
  sessionTtlMs?: number;
  allowedOrigins?: readonly string[];
  secureCookies?: boolean;
  tradingOptions?: TradingOptions;
  onTradeCommitted?: (affectedUserIds: readonly string[]) => void;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const defaults = readConfig({});
  const store = options.store ?? createMemoryStore();
  const sessions =
    options.sessions ??
    createSessionService(store, { ttlMs: options.sessionTtlMs ?? defaults.SESSION_TTL_MS });
  const secureCookies = options.secureCookies ?? defaults.COOKIE_SECURE;
  const allowedOrigins = options.allowedOrigins ?? defaults.ALLOWED_ORIGINS;
  const clientDistPath =
    options.clientDistPath ?? fileURLToPath(new URL('../../client/dist/', import.meta.url));

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Request-Id', randomUUID());
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', createHealthRouter());
  app.use('/api/auth', createAuthRouter(store, sessions, { secureCookies, allowedOrigins }));
  app.use('/api', createAccountRouter(store, sessions, secureCookies));
  app.use(
    '/api',
    createTradingRouter(store, sessions, {
      secureCookies,
      allowedOrigins,
      tradingOptions: options.tradingOptions,
      onTradeCommitted: options.onTradeCommitted,
    }),
  );
  app.use('/api', (_req, res) => {
    sendError(res, 404, 'NOT_FOUND', '接口不存在');
  });

  // WebSocket upgrades are handled on the shared HTTP server.
  app.use('/ws', (_req, res) => {
    res.setHeader('Upgrade', 'websocket');
    sendError(res, 426, 'UPGRADE_REQUIRED', '请使用 WebSocket 连接');
  });
  app.use(express.static(clientDistPath, { index: false }));

  app.get('/{*path}', (req, res, next) => {
    if (extname(req.path) || req.path === '/assets' || req.path.startsWith('/assets/')) {
      next();
      return;
    }
    if (!req.accepts('html')) {
      next();
      return;
    }
    const indexPath = join(clientDistPath, 'index.html');
    if (!existsSync(indexPath)) {
      sendError(res, 503, 'FRONTEND_NOT_BUILT', '请先运行 npm run build，或访问前端开发服务');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexPath);
  });

  app.use((_req, res) => {
    sendError(res, 404, 'NOT_FOUND', '资源不存在');
  });
  app.use(errorHandler);
  return app;
}
