import {
  MAX_ORDER_QUANTITY,
  MAX_PRICE_CENTS,
  STOCKS,
  type CreateOrderRequest,
} from '@stock/shared';
import type { AccountOwner } from '../stores/account.js';
const storageError = () =>
  new Error('浏览器存储无法保存或读取委托恢复记录，已暂停新下单。请恢复本标签页的存储后刷新账户。');
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
function validRequest(value: unknown): value is CreateOrderRequest {
  return (
    object(value) &&
    Object.keys(value).length === 5 &&
    typeof value.clientOrderId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.clientOrderId,
    ) &&
    STOCKS.some((stock) => stock.symbol === value.symbol) &&
    (value.side === 'BUY' || value.side === 'SELL') &&
    positive(value.priceCents, MAX_PRICE_CENTS) &&
    positive(value.quantity, MAX_ORDER_QUANTITY)
  );
}
const key = (owner: AccountOwner) =>
  'stock.pending-order.v1:' + JSON.stringify([owner.serverEpoch, owner.userId]);
const same = (left: CreateOrderRequest, right: CreateOrderRequest) =>
  left.clientOrderId === right.clientOrderId &&
  left.symbol === right.symbol &&
  left.side === right.side &&
  left.priceCents === right.priceCents &&
  left.quantity === right.quantity;
export function readPendingOrder(owner: AccountOwner): Readonly<CreateOrderRequest> | null {
  try {
    const raw = sessionStorage.getItem(key(owner));
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !object(value) ||
      value.version !== 1 ||
      value.userId !== owner.userId ||
      value.serverEpoch !== owner.serverEpoch ||
      !validRequest(value.request)
    )
      throw storageError();
    return Object.freeze({ ...value.request });
  } catch {
    throw storageError();
  }
}
export function writePendingOrder(owner: AccountOwner, request: CreateOrderRequest): void {
  try {
    if (!validRequest(request)) throw storageError();
    const previous = readPendingOrder(owner);
    if (previous && !same(previous, request)) throw storageError();
    const value = JSON.stringify({
      version: 1,
      userId: owner.userId,
      serverEpoch: owner.serverEpoch,
      request,
    });
    sessionStorage.setItem(key(owner), value);
    // A successful setter must leave a readable record before the network can mutate funds.
    if (sessionStorage.getItem(key(owner)) !== value) throw storageError();
  } catch {
    throw storageError();
  }
}
export function removePendingOrder(owner: AccountOwner, request: CreateOrderRequest): void {
  try {
    const previous = readPendingOrder(owner);
    if (previous && !same(previous, request)) throw storageError();
    sessionStorage.removeItem(key(owner));
    if (sessionStorage.getItem(key(owner)) !== null) throw storageError();
  } catch {
    throw storageError();
  }
}
