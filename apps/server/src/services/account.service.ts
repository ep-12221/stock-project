import type { AccountStateDto, AccountDto, OrderDto, PositionDto, StocksDto } from '@stock/shared';
import { AppError } from '../domain/app-error.js';
import { isActive } from '../matching/order-book.js';
import type { MemoryStore } from '../store/memory-store.js';
import { orderDto, personalTradeDto } from './trading-dto.js';

export function accountSnapshot(store: MemoryStore, userId: string): AccountStateDto {
  const account = store.accounts.get(userId);
  if (!account) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
  const accountDto: AccountDto = {
    cashBalanceCents: account.cashBalanceCents,
    frozenCashCents: account.frozenCashCents,
    availableCashCents: account.cashBalanceCents - account.frozenCashCents,
  };
  const positions: PositionDto[] = [...(store.positions.get(userId)?.values() ?? [])].map((p) => ({
    symbol: p.symbol,
    quantity: p.quantity,
    frozenQuantity: p.frozenQuantity,
    availableQuantity: p.quantity - p.frozenQuantity,
  }));
  const activeOrders = [...(store.activeOrdersByUser.get(userId) ?? [])]
    .map((id) => orderDto(store.orders.get(id)!))
    .sort((a, b) => b.sequence - a.sequence);
  const recentClosedOrders: OrderDto[] = [];
  const history = store.ordersByUser.get(userId) ?? [];
  for (let i = history.length - 1; i >= 0 && recentClosedOrders.length < 100; i--) {
    const order = store.orders.get(history[i]!)!;
    if (!isActive(order)) recentClosedOrders.push(orderDto(order));
  }
  const recentTrades = (store.tradesByUser.get(userId) ?? [])
    .slice(-50)
    .reverse()
    .map((id) => personalTradeDto(store.trades.get(id)!, userId));
  return {
    serverEpoch: store.serverEpoch,
    userId,
    accountVersion: account.version,
    account: accountDto,
    positions,
    activeOrders,
    recentClosedOrders,
    recentTrades,
  };
}

export function stockSnapshot(store: MemoryStore): StocksDto {
  return {
    serverEpoch: store.serverEpoch,
    marketVersion: store.marketVersion,
    quotes: [...store.stocks.values()].map((quote) => ({ ...quote })),
  };
}
