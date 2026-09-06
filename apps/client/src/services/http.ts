import type { ApiErrorResponse, ApiSuccess, HealthDto } from '@stock/shared';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
interface ApiOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}
export async function apiRequest<T = void>(path: string, options: ApiOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      signal: options.signal ?? AbortSignal.timeout(10_000),
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new Error('无法连接服务或请求超时，请稍后重试');
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as ApiSuccess<T> | ApiErrorResponse | null;
  if (!response.ok) {
    const error = body && 'error' in body ? body.error : null;
    throw new HttpError(
      response.status,
      error?.message ?? '服务暂时不可用（HTTP ' + response.status + '）',
      error?.code,
    );
  }
  if (!body || !('data' in body)) throw new Error('服务响应格式不正确');
  return body.data;
}
export async function getHealth(signal: AbortSignal): Promise<HealthDto> {
  const data = await apiRequest<HealthDto>('/api/health', { signal });
  if (data?.status !== 'ok' || data.service !== '@stock/server') {
    throw new Error('服务响应格式不正确');
  }
  return data;
}
