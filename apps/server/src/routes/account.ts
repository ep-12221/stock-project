import { Router } from 'express';
import { createAuthMiddleware, currentSession } from '../middleware/auth.js';
import { accountSnapshot, stockSnapshot } from '../services/account.service.js';
import type { SessionService } from '../services/session.service.js';
import type { MemoryStore } from '../store/memory-store.js';

export function createAccountRouter(
  store: MemoryStore,
  sessions: SessionService,
  secureCookies: boolean,
) {
  const router = Router();
  const { requireAuth } = createAuthMiddleware(sessions, secureCookies);
  const noStore = (
    _req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
  router.get('/me/snapshot', noStore, requireAuth, (_req, res) => {
    res.json({ data: accountSnapshot(store, currentSession(res).userId) });
  });
  router.get('/me/account', noStore, requireAuth, (_req, res) => {
    const { serverEpoch, accountVersion, account } = accountSnapshot(
      store,
      currentSession(res).userId,
    );
    res.json({ data: { serverEpoch, accountVersion, account } });
  });
  router.get('/me/positions', noStore, requireAuth, (_req, res) => {
    const { serverEpoch, accountVersion, positions } = accountSnapshot(
      store,
      currentSession(res).userId,
    );
    res.json({ data: { serverEpoch, accountVersion, positions } });
  });
  router.get('/stocks', noStore, requireAuth, (_req, res) => {
    res.json({ data: stockSnapshot(store) });
  });
  return router;
}
