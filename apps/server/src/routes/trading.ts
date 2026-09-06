import { Router, type RequestHandler } from 'express';
import type { CreateOrderResponse } from '@stock/shared';
import {
  createAuthMiddleware,
  currentSession,
  requireAllowedOrigin,
  requireJson,
} from '../middleware/auth.js';
import { accountSnapshot } from '../services/account.service.js';
import type { SessionService } from '../services/session.service.js';
import { createTradingService, type TradingOptions } from '../services/trading.service.js';
import { orderDto } from '../services/trading-dto.js';
import {
  queryMarketTrades,
  queryOrders,
  queryPersonalTrades,
} from '../services/trading-query.service.js';
import type { MemoryStore } from '../store/memory-store.js';

export function createTradingRouter(
  store: MemoryStore,
  sessions: SessionService,
  options: {
    secureCookies: boolean;
    allowedOrigins: readonly string[];
    tradingOptions?: TradingOptions | undefined;
    onTradeCommitted?: ((affectedUserIds: readonly string[]) => void) | undefined;
  },
) {
  const router = Router();
  const trading = createTradingService(store, options.tradingOptions);
  const { requireAuth } = createAuthMiddleware(sessions, options.secureCookies);
  const noStore: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
  router.post(
    '/orders',
    noStore,
    requireAllowedOrigin(options.allowedOrigins),
    requireAuth,
    requireJson,
    (req, res) => {
      const userId = currentSession(res).userId;
      const result = trading.submitOrder(userId, req.body);
      const data: CreateOrderResponse = {
        order: orderDto(result.order),
        snapshot: accountSnapshot(store, userId),
      };
      res.status(result.replayed ? 200 : 201).json({ data });
      if (result.replayed) return;
      try {
        options.onTradeCommitted?.(result.affectedUserIds);
      } catch {
        // Settlement is committed; delivery failures cannot fail or roll back this HTTP command.
      }
    },
  );
  router.get('/me/orders', noStore, requireAuth, (req, res) => {
    res.json({ data: queryOrders(store, currentSession(res).userId, req.query) });
  });
  router.get('/me/trades', noStore, requireAuth, (req, res) => {
    res.json({ data: queryPersonalTrades(store, currentSession(res).userId, req.query) });
  });
  router.get('/trades', noStore, requireAuth, (req, res) => {
    res.json({ data: queryMarketTrades(store, req.query) });
  });
  return router;
}
