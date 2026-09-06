import type { AccountStateDto, OrderDto, RealtimeEvent } from '@stock/shared';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number => integer(value) && value > 0;
const timestamp = (value: unknown): value is string =>
  text(value) && Number.isFinite(Date.parse(value));
const list = (value: unknown, check: (item: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(check);
const side = (value: unknown) => value === 'BUY' || value === 'SELL';
function trade(value: unknown): boolean {
  return (
    object(value) &&
    text(value.id) &&
    positive(value.sequence) &&
    text(value.symbol) &&
    positive(value.priceCents) &&
    positive(value.quantity) &&
    timestamp(value.executedAt)
  );
}
export function isOrderDto(value: unknown): value is OrderDto {
  return (
    object(value) &&
    text(value.id) &&
    positive(value.sequence) &&
    text(value.symbol) &&
    side(value.side) &&
    positive(value.priceCents) &&
    positive(value.quantity) &&
    integer(value.filledQuantity) &&
    value.filledQuantity <= value.quantity &&
    integer(value.executedValueCents) &&
    typeof value.status === 'string' &&
    ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED'].includes(value.status) &&
    timestamp(value.createdAt) &&
    timestamp(value.updatedAt)
  );
}
function position(value: unknown): boolean {
  return (
    object(value) &&
    text(value.symbol) &&
    integer(value.quantity) &&
    integer(value.frozenQuantity) &&
    integer(value.availableQuantity) &&
    value.quantity - value.frozenQuantity === value.availableQuantity
  );
}
export function isAccountStateDto(value: unknown): value is AccountStateDto {
  if (!object(value) || !object(value.account)) return false;
  const cash = value.account;
  return (
    text(value.userId) &&
    text(value.serverEpoch) &&
    integer(value.accountVersion) &&
    integer(cash.cashBalanceCents) &&
    integer(cash.frozenCashCents) &&
    integer(cash.availableCashCents) &&
    cash.cashBalanceCents - cash.frozenCashCents === cash.availableCashCents &&
    list(value.positions, position) &&
    list(value.activeOrders, isOrderDto) &&
    list(value.recentClosedOrders, isOrderDto) &&
    list(
      value.recentTrades,
      (item) => trade(item) && object(item) && side(item.side) && text(item.orderId),
    )
  );
}
function quote(value: unknown): boolean {
  return (
    object(value) &&
    text(value.symbol) &&
    text(value.name) &&
    positive(value.previousCloseCents) &&
    positive(value.lastPriceCents) &&
    typeof value.changePercent === 'number' &&
    Number.isFinite(value.changePercent) &&
    (value.bestBidCents === null || positive(value.bestBidCents)) &&
    (value.bestAskCents === null || positive(value.bestAskCents)) &&
    timestamp(value.updatedAt)
  );
}
function market(value: unknown): boolean {
  return (
    object(value) &&
    integer(value.marketVersion) &&
    list(value.quotes, quote) &&
    list(value.recentTrades, trade)
  );
}

// HTTP DTO types do not validate WebSocket JSON at runtime. Validate both snapshot
// domains completely before letting either store replace visible state.
export function parseRealtimeEvent(data: unknown): RealtimeEvent | null {
  if (typeof data !== 'string') return null;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (!object(event) || !text(event.serverEpoch) || !timestamp(event.emittedAt)) return null;
  const valid =
    event.type === 'state.snapshot'
      ? object(event.payload) &&
        market(event.payload.market) &&
        isAccountStateDto(event.payload.account)
      : event.type === 'market.updated'
        ? market(event.payload)
        : event.type === 'account.updated' && isAccountStateDto(event.payload);
  return valid ? (event as unknown as RealtimeEvent) : null;
}
