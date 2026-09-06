import type { ApiSuccess, HealthDto } from '@stock/shared';
import { Router } from 'express';

export function createHealthRouter() {
  const router = Router();
  router.get('/health', (_req, res) => {
    const body: ApiSuccess<HealthDto> = {
      data: {
        status: 'ok',
        service: '@stock/server',
        serverTime: new Date().toISOString(),
      },
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });
  return router;
}
