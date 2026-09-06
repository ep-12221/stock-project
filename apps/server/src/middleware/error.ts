import { AppError } from '../domain/app-error.js';
import type { ApiErrorResponse, ErrorCode } from '@stock/shared';
import type { ErrorRequestHandler, Response } from 'express';

export function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  const body: ApiErrorResponse = {
    error: { code, message },
    requestId: String(res.getHeader('X-Request-Id') ?? ''),
  };
  res.status(status).json(body);
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    sendError(res, error.status, error.code, error.message);
    return;
  }

  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : 500;

  if (status === 400) {
    sendError(res, 400, 'VALIDATION_ERROR', '请求格式不正确');
    return;
  }
  if (status === 413) {
    sendError(res, 413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
    return;
  }

  if (status === 415) {
    sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', '请求的字符集或内容编码不受支持');
    return;
  }

  console.error('Request failed:', res.getHeader('X-Request-Id'), error);
  sendError(res, 500, 'INTERNAL_ERROR', '服务暂时不可用');
};
