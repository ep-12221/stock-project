import { AppError } from '../domain/app-error.js';

export function invariant(condition: unknown): asserts condition {
  if (!condition) throw new AppError(500, 'INTERNAL_ERROR', '交易状态校验失败');
}

/** All stored monetary, quantity and sequence values are non-negative safe integers. */
export function integer(value: number): number {
  invariant(Number.isSafeInteger(value) && value >= 0);
  return value;
}
