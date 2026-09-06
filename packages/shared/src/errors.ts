export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN_ORIGIN'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'NOT_IMPLEMENTED'
  | 'UPGRADE_REQUIRED'
  | 'FRONTEND_NOT_BUILT'
  | 'VALIDATION_ERROR'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'USERNAME_EXISTS'
  | 'STOCK_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'INSUFFICIENT_POSITION'
  | 'SELF_TRADE_PREVENTED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ORDER_NOT_CANCELLABLE'
  | 'RATE_LIMITED'
  | 'ORDER_LIMIT_REACHED'
  | 'INTERNAL_ERROR';

export interface ApiErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId: string;
}
