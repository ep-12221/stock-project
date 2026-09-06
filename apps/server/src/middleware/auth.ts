import type { CookieOptions, RequestHandler, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { AppError } from '../domain/app-error.js';
import type { Session } from '../domain/models.js';
import type { SessionService } from '../services/session.service.js';

export const SESSION_COOKIE = 'stock_session';

export function readSessionCookie(req: Pick<IncomingMessage, 'headers'>): string | undefined {
  const value = req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(SESSION_COOKIE + '='))
    ?.slice(SESSION_COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export function createAuthMiddleware(sessions: SessionService, secureCookies: boolean) {
  const cookieOptions: CookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    path: '/',
  };
  function clearCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE, cookieOptions);
  }
  function setCookie(res: Response, session: Session): void {
    res.cookie(SESSION_COOKIE, session.id, {
      ...cookieOptions,
      maxAge: session.expiresAt - session.createdAt,
    });
  }
  const requireAuth: RequestHandler = (req, res, next) => {
    const session = sessions.resolve(readSessionCookie(req));
    if (!session) {
      clearCookie(res);
      next(new AppError(401, 'UNAUTHENTICATED', '请先登录'));
      return;
    }
    res.locals.session = session;
    next();
  };
  return { requireAuth, setCookie, clearCookie };
}

export function currentSession(res: Response): Session {
  return res.locals.session as Session;
}

export function requireAllowedOrigin(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    const origin = req.get('Origin');
    if (!origin || !allowed.has(origin)) {
      next(new AppError(403, 'FORBIDDEN_ORIGIN', '请求来源不被允许'));
      return;
    }
    next();
  };
}

export const requireJson: RequestHandler = (req, _res, next) => {
  if (!req.is('application/json')) {
    next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 JSON 提交'));
    return;
  }
  next();
};
