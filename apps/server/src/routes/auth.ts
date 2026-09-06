import type { AuthDto } from '@stock/shared';
import { Router } from 'express';
import type { MemoryStore } from '../store/memory-store.js';
import type { SessionService } from '../services/session.service.js';
import { createAuthService } from '../services/auth.service.js';
import {
  createAuthMiddleware,
  currentSession,
  readSessionCookie,
  requireAllowedOrigin,
  requireJson,
} from '../middleware/auth.js';

export function createAuthRouter(
  store: MemoryStore,
  sessions: SessionService,
  options: { secureCookies: boolean; allowedOrigins: readonly string[] },
) {
  const router = Router();
  const auth = createAuthService(store, sessions);
  const middleware = createAuthMiddleware(sessions, options.secureCookies);
  const allowedOrigin = requireAllowedOrigin(options.allowedOrigins);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  for (const action of ['register', 'login'] as const) {
    router.post('/' + action, allowedOrigin, requireJson, async (req, res) => {
      const { user, session } = await auth[action](req.body, readSessionCookie(req));
      middleware.setCookie(res, session);
      const data: AuthDto = {
        user: { id: user.id, username: user.username },
        serverEpoch: store.serverEpoch,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
      res.status(action === 'register' ? 201 : 200).json({ data });
    });
  }

  router.get('/me', middleware.requireAuth, (_req, res) => {
    const session = currentSession(res);
    const user = store.users.get(session.userId)!;
    const data: AuthDto = {
      user: { id: user.id, username: user.username },
      serverEpoch: store.serverEpoch,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
    res.json({ data });
  });
  router.post('/logout', allowedOrigin, middleware.requireAuth, (_req, res) => {
    sessions.revoke(currentSession(res).id);
    middleware.clearCookie(res);
    res.sendStatus(204);
  });
  return router;
}
