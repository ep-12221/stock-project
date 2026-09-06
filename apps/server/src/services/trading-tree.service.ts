import { randomUUID } from 'node:crypto';
import { MAX_ORDER_QUANTITY, MAX_PRICE_CENTS } from '@stock/shared';
import { z } from 'zod';
import { AppError } from '../domain/app-error.js';
import type { Order, Trade } from '../domain/models.js';
import type { MemoryStore } from '../store/memory-store.js';
import { integer, invariant } from '../matching/checked.js';
import { isActive } from '../matching/order-book.js';
import { PriceTreeOrderBook } from '../matching/price-tree-book.js';
import {
  assertConservation,
  assertOrder,
  assertReservations,
  createSettlementDraft,
  freezeOrder,
  settleFill,
} from '../matching/settlement.js';

// Internal callers may omit the key; the public entry point always requires one.
const clientOrderIdInput = z.uuid().transform((value) => value.toLowerCase());
const orderInput = z.strictObject({
  clientOrderId: clientOrderIdInput.optional(),
  symbol: z.string().min(1).max(32),
  side: z.enum(['BUY', 'SELL']),
  priceCents: z.number().int().min(1).max(MAX_PRICE_CENTS),
  quantity: z.number().int().min(1).max(MAX_ORDER_QUANTITY),
});

const publicOrderInput = orderInput.extend({ clientOrderId: clientOrderIdInput });

export interface SubmitOrderResult {
  replayed: boolean;
  /** Internal result: map to public DTOs before exposing through HTTP or WebSocket. */
  order: Order;
  trades: Trade[];
  affectedUserIds: string[];
  marketVersion: number;
}
export interface TradingOptions {
  maxActiveOrdersPerUser?: number;
  maxActiveOrders?: number;
}

export function createTradingService(store: MemoryStore, options: TradingOptions = {}) {
  const maxPerUser = options.maxActiveOrdersPerUser ?? 100;
  const maxGlobal = options.maxActiveOrders ?? 5_000;
  for (const limit of [maxPerUser, maxGlobal]) {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error('Active order limits must be positive safe integers');
  }

  /** Public command: the API obtains userId from its authenticated session. */
  function submitOrder(userId: string, input: unknown): SubmitOrderResult {
    return executeOrder(userId, input, true);
  }

  /** Trusted internal command, including seeded liquidity and matching tests. */
  function submitLimitOrder(userId: string, input: unknown): SubmitOrderResult {
    return executeOrder(userId, input, false);
  }

  function executeOrder(userId: string, input: unknown, requireKey: boolean): SubmitOrderResult {
    if (!store.users.has(userId) || !store.accounts.has(userId)) {
      throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    }
    const parsed = (requireKey ? publicOrderInput : orderInput).safeParse(input);
    if (!parsed.success)
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        '请输入合法的股票、方向、整数价格、数量和请求标识',
      );
    const { clientOrderId, ...data } = parsed.data;
    const fingerprint = JSON.stringify([data.symbol, data.side, data.priceCents, data.quantity]);
    const previous = clientOrderId
      ? store.idempotentOrdersByUser.get(userId)?.get(clientOrderId)
      : undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '请求标识已用于不同的委托，请核对原委托');
      }
      const order = store.orders.get(previous.orderId);
      invariant(order && order.userId === userId);
      return {
        order: { ...order },
        trades: [],
        affectedUserIds: [],
        marketVersion: store.marketVersion,
        replayed: true,
      };
    }
    integer(data.priceCents * data.quantity);
    const quote = store.stocks.get(data.symbol);
    if (!quote) throw new AppError(404, 'STOCK_NOT_FOUND', '股票不存在');
    if (
      (store.activeOrdersByUser.get(userId)?.size ?? 0) >= maxPerUser ||
      store.activeOrderCount >= maxGlobal
    ) {
      throw new AppError(429, 'ORDER_LIMIT_REACHED', '活跃委托数量已达上限');
    }

    const book = store.orderBooks.get(data.symbol);
    invariant(book instanceof PriceTreeOrderBook);
    const storedOrder = (id: string): Order => {
      const order = store.orders.get(id);
      invariant(order);
      return order;
    };
    const incoming = { ...data, userId };
    const plan = book.planMatches(incoming, (id) => {
      const maker = storedOrder(id);
      invariant(store.activeOrdersByUser.get(maker.userId)?.has(id));
      return maker;
    });
    const affectedUserIds = [
      ...new Set([userId, ...plan.map((fill) => storedOrder(fill.makerOrderId).userId)]),
    ];
    const draft = createSettlementDraft(store, affectedUserIds);
    const orderSequence = integer(store.orderSequence + 1);
    const timestamp = store.now();
    invariant(Number.isSafeInteger(timestamp) && Number.isFinite(new Date(timestamp).getTime()));
    const createdAt = new Date(timestamp).toISOString();
    const order: Order = {
      ...incoming,
      id: randomUUID(),
      sequence: orderSequence,
      filledQuantity: 0,
      executedValueCents: 0,
      status: 'OPEN',
      createdAt,
      updatedAt: createdAt,
    };
    const orders = new Map<string, Order>([[order.id, order]]);
    freezeOrder(draft, order);
    draft.activeOrdersByUser.get(userId)!.add(order.id);
    let tradeSequence = integer(store.tradeSequence);
    const trades: Trade[] = [];
    for (const fill of plan) {
      const maker = { ...storedOrder(fill.makerOrderId) };
      orders.set(maker.id, maker);
      const buy = order.side === 'BUY' ? order : maker;
      const sell = order.side === 'SELL' ? order : maker;
      settleFill(draft, buy, sell, fill.priceCents, fill.quantity, createdAt);
      tradeSequence = integer(tradeSequence + 1);
      trades.push({
        id: randomUUID(),
        sequence: tradeSequence,
        symbol: data.symbol,
        priceCents: fill.priceCents,
        quantity: fill.quantity,
        executedAt: createdAt,
        buyOrderId: buy.id,
        sellOrderId: sell.id,
        buyerUserId: buy.userId,
        sellerUserId: sell.userId,
      });
    }
    for (const changed of orders.values()) {
      assertOrder(changed);
      if (!isActive(changed)) draft.activeOrdersByUser.get(changed.userId)!.delete(changed.id);
    }
    const getOrder = (id: string) => orders.get(id) ?? storedOrder(id);
    const bookUpdate = book.prepare(order, orders);
    const { bestBidCents, bestAskCents } = bookUpdate;
    let activeOrderCount = integer(store.activeOrderCount);
    for (const [id, active] of draft.activeOrdersByUser) {
      activeOrderCount += active.size - (store.activeOrdersByUser.get(id)?.size ?? 0);
      const account = draft.accounts.get(id)!;
      account.version = integer(account.version + 1);
    }
    integer(activeOrderCount);
    assertReservations(draft, getOrder);
    assertConservation(store, draft);
    const marketVersion = integer(store.marketVersion + 1);
    const nextQuote = { ...quote, bestBidCents, bestAskCents, updatedAt: createdAt };
    const result: SubmitOrderResult = {
      replayed: false,
      order: { ...order },
      trades: trades.map((trade) => ({ ...trade })),
      affectedUserIds: [...affectedUserIds],
      marketVersion,
    };

    // Apply the prepared book and settlement together, after every business check; no await or I/O.
    bookUpdate.commit();
    for (const [id, account] of draft.accounts) store.accounts.set(id, account);
    for (const [id, positions] of draft.positions) store.positions.set(id, positions);
    for (const [id, active] of draft.activeOrdersByUser) store.activeOrdersByUser.set(id, active);
    for (const [id, changed] of orders) store.orders.set(id, changed);
    const userOrders = store.ordersByUser.get(userId) ?? [];
    userOrders.push(order.id);
    store.ordersByUser.set(userId, userOrders);
    for (const trade of trades) {
      store.trades.set(trade.id, trade);
      store.marketTradeIds.push(trade.id);
      for (const id of [trade.buyerUserId, trade.sellerUserId]) {
        const userTrades = store.tradesByUser.get(id) ?? [];
        userTrades.push(trade.id);
        store.tradesByUser.set(id, userTrades);
      }
    }
    store.stocks.set(data.symbol, nextQuote);
    store.orderSequence = orderSequence;
    store.tradeSequence = tradeSequence;
    store.activeOrderCount = activeOrderCount;
    store.marketVersion = marketVersion;
    if (clientOrderId) {
      const userCommands = store.idempotentOrdersByUser.get(userId) ?? new Map();
      userCommands.set(clientOrderId, { orderId: order.id, fingerprint });
      store.idempotentOrdersByUser.set(userId, userCommands);
    }
    return result;
  }
  return { submitOrder, submitLimitOrder };
}
