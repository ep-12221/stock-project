import {
  MAX_ORDER_QUANTITY,
  MAX_PRICE_CENTS,
  type PositionDto,
  type StockQuote,
} from '@stock/shared';
export function parsePrice(text: string): number {
  const value = text.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('价格须为最多两位小数的正数');
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_PRICE_CENTS)
    throw new Error('价格须为 0.01～100,000.00');
  return cents;
}
export function parseQuantity(text: string): number {
  const value = text.trim();
  const quantity = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_ORDER_QUANTITY
  )
    throw new Error('数量须为 1～100,000 的整数股');
  return quantity;
}
export function formatMoney(cents: number | bigint): string {
  const value = BigInt(cents);
  const absolute = value < 0n ? -value : value;
  return (
    (value < 0n ? '-' : '') +
    (absolute / 100n).toLocaleString('zh-CN') +
    '.' +
    (absolute % 100n).toString().padStart(2, '0')
  );
}
export const priceInput = (cents: number) => (cents / 100).toFixed(2);
export function portfolioValue(
  positions: readonly PositionDto[],
  quotes: readonly StockQuote[],
): bigint {
  const prices = new Map(quotes.map((quote) => [quote.symbol, quote.lastPriceCents]));
  return positions.reduce(
    (sum, p) => sum + BigInt(p.quantity) * BigInt(prices.get(p.symbol) ?? 0),
    0n,
  );
}
export function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
