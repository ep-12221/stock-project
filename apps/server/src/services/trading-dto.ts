import type { OrderDto, PersonalTradeDto, PublicTradeDto } from '@stock/shared';
import type { Order, Trade } from '../domain/models.js';
import { invariant } from '../matching/checked.js';

export function orderDto(order: Order): OrderDto {
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    priceCents: order.priceCents,
    quantity: order.quantity,
    filledQuantity: order.filledQuantity,
    executedValueCents: order.executedValueCents,
    status: order.status,
    sequence: order.sequence,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
export function publicTradeDto(trade: Trade): PublicTradeDto {
  return {
    id: trade.id,
    sequence: trade.sequence,
    symbol: trade.symbol,
    priceCents: trade.priceCents,
    quantity: trade.quantity,
    executedAt: trade.executedAt,
  };
}
export function personalTradeDto(trade: Trade, userId: string): PersonalTradeDto {
  invariant(trade.buyerUserId === userId || trade.sellerUserId === userId);
  const isBuyer = trade.buyerUserId === userId;
  return {
    ...publicTradeDto(trade),
    side: isBuyer ? 'BUY' : 'SELL',
    orderId: isBuyer ? trade.buyOrderId : trade.sellOrderId,
  };
}
