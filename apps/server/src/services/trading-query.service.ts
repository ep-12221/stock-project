import type {
  OrderHistoryDto,
  PersonalTradeHistoryDto,
  MarketTradeHistoryDto,
  Paginated,
} from '@stock/shared';
import { z } from 'zod';
import { AppError } from '../domain/app-error.js';
import { invariant } from '../matching/checked.js';
import type { MemoryStore } from '../store/memory-store.js';
import { orderDto, personalTradeDto, publicTradeDto } from './trading-dto.js';

const positiveInteger = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER));
const fields = {
  symbol: z.string().min(1).max(32).optional(),
  cursor: positiveInteger.optional(),
  limit: positiveInteger.pipe(z.number().max(100)).default(50),
};
const tradeQuery = z.strictObject(fields);
const orderQuery = z.strictObject({
  ...fields,
  status: z.enum(['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED']).optional(),
});

function parseQuery(store: MemoryStore, input: unknown, orders: boolean) {
  const parsed = (orders ? orderQuery : tradeQuery).safeParse(input);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', '查询参数不正确');
  const query = parsed.data;
  if (query.symbol !== undefined && !store.stocks.has(query.symbol)) {
    throw new AppError(404, 'STOCK_NOT_FOUND', '股票不存在');
  }
  return { ...query, status: 'status' in query ? query.status : undefined };
}

/** Indexes are append-only in sequence order. Read one extra match to determine the next cursor. */
function page<T extends { sequence: number }>(
  ids: readonly string[],
  records: ReadonlyMap<string, T>,
  query: { limit: number; cursor?: number | undefined },
  matches: (item: T) => boolean,
): Paginated<T> {
  const items: T[] = [];
  for (let index = ids.length - 1; index >= 0; index--) {
    const record = records.get(ids[index]!);
    invariant(record);
    if (query.cursor !== undefined && record.sequence >= query.cursor) continue;
    if (!matches(record)) continue;
    if (items.length === query.limit) return { items, nextCursor: items.at(-1)!.sequence };
    items.push(record);
  }
  return { items, nextCursor: null };
}

function userMetadata(store: MemoryStore, userId: string) {
  const account = store.accounts.get(userId);
  if (!account) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
  return { serverEpoch: store.serverEpoch, userId, accountVersion: account.version };
}

export function queryOrders(store: MemoryStore, userId: string, input: unknown): OrderHistoryDto {
  const metadata = userMetadata(store, userId);
  const query = parseQuery(store, input, true);
  const result = page(
    store.ordersByUser.get(userId) ?? [],
    store.orders,
    query,
    (order) =>
      order.userId === userId &&
      (query.symbol === undefined || order.symbol === query.symbol) &&
      (query.status === undefined || order.status === query.status),
  );
  return { ...metadata, ...result, items: result.items.map(orderDto) };
}

export function queryPersonalTrades(
  store: MemoryStore,
  userId: string,
  input: unknown,
): PersonalTradeHistoryDto {
  const metadata = userMetadata(store, userId);
  const query = parseQuery(store, input, false);
  const result = page(
    store.tradesByUser.get(userId) ?? [],
    store.trades,
    query,
    (trade) =>
      (trade.buyerUserId === userId || trade.sellerUserId === userId) &&
      (query.symbol === undefined || trade.symbol === query.symbol),
  );
  return {
    ...metadata,
    ...result,
    items: result.items.map((trade) => personalTradeDto(trade, userId)),
  };
}

export function queryMarketTrades(store: MemoryStore, input: unknown): MarketTradeHistoryDto {
  const query = parseQuery(store, input, false);
  const result = page(
    store.marketTradeIds,
    store.trades,
    query,
    (trade) => query.symbol === undefined || trade.symbol === query.symbol,
  );
  return {
    serverEpoch: store.serverEpoch,
    marketVersion: store.marketVersion,
    ...result,
    items: result.items.map(publicTradeDto),
  };
}
