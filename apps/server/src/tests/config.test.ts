import { describe, expect, it } from 'vitest';
import { readConfig } from '../config.js';

describe('identity configuration', () => {
  it('defaults to a 24-hour session and local HTTP cookies', () => {
    const config = readConfig({});
    expect(config.SESSION_TTL_MS).toBe(86_400_000);
    expect(config.COOKIE_SECURE).toBe(false);
    expect(config.ALLOWED_ORIGINS).toContain('http://localhost:5173');
    expect(config.ALLOWED_ORIGINS).toContain('http://localhost:3000');
  });

  it('derives local origins from PORT and parses explicit HTTPS configuration', () => {
    expect(readConfig({ PORT: '3001' }).ALLOWED_ORIGINS).toContain('http://localhost:3001');
    const config = readConfig({ COOKIE_SECURE: 'true', ALLOWED_ORIGINS: 'https://stock.example' });
    expect(config.COOKIE_SECURE).toBe(true);
    expect(config.ALLOWED_ORIGINS).toEqual(['https://stock.example']);
  });

  it.each([
    { SESSION_TTL_MS: '0' },
    { SESSION_TTL_MS: '-1' },
    { SESSION_TTL_MS: 'abc' },
    { COOKIE_SECURE: 'yes' },
    { ALLOWED_ORIGINS: '*' },
    { ALLOWED_ORIGINS: 'https://stock.example/path' },
    { ALLOWED_ORIGINS: '' },
  ])('rejects invalid identity configuration %j', (env) => {
    expect(() => readConfig(env)).toThrow();
  });
});

describe('demo liquidity configuration', () => {
  it.each([
    [undefined, true],
    ['true', true],
    ['false', false],
  ] as const)('parses %s as %s', (value, expected) => {
    expect(readConfig({ ENABLE_DEMO_LIQUIDITY: value })).toHaveProperty(
      'ENABLE_DEMO_LIQUIDITY',
      expected,
    );
  });
  it.each(['yes', '0', ''])('rejects invalid flag %s', (value) => {
    expect(() => readConfig({ ENABLE_DEMO_LIQUIDITY: value })).toThrow();
  });
});
