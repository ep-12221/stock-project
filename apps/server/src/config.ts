import { z } from 'zod';

const originSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}, 'ALLOWED_ORIGINS must contain exact HTTP(S) origins');

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  HOST: z.string().min(1).default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MATCHING_ENGINE: z.enum(['array', 'price-tree']).default('price-tree'),
  SESSION_TTL_MS: z.coerce.number().int().min(1).max(2_592_000_000).default(86_400_000),
  ENABLE_DEMO_LIQUIDITY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ALLOWED_ORIGINS: z.string().trim().min(1).optional(),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = configSchema.parse(env);
  const rawOrigins = config.ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()) ?? [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:' + config.PORT,
    'http://127.0.0.1:' + config.PORT,
  ];
  return { ...config, ALLOWED_ORIGINS: z.array(originSchema).min(1).parse(rawOrigins) };
}
