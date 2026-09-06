// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, HttpError } from '../services/http.js';

afterEach(() => vi.unstubAllGlobals());
describe('authenticated HTTP client', () => {
  it('sends JSON with same-origin credentials and unwraps the response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: { ok: true } })));
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await apiRequest('/api/auth/login', { method: 'POST', body: { username: 'alice' } }),
    ).toEqual({ ok: true });
    const init = fetchMock.mock.calls[0]![1];
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });
  it('handles a 204 response without trying to parse JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    expect(await apiRequest('/api/auth/logout', { method: 'POST' })).toBeUndefined();
  });
  it('preserves HTTP status and business error codes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'UNAUTHENTICATED', message: '请先登录' },
          }),
          { status: 401 },
        ),
      ),
    );
    await expect(apiRequest('/api/auth/me')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
      message: '请先登录',
    });
    expect(HttpError.prototype).toBeInstanceOf(Error);
  });
  it('handles non-JSON error responses and connection failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockRejectedValueOnce(new TypeError('network'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiRequest('/api/auth/me')).rejects.toMatchObject({ status: 502 });
    await expect(apiRequest('/api/auth/me')).rejects.toThrow('连接');
  });
});
