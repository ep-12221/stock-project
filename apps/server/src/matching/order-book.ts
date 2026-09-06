import type { Side } from '@stock/shared';
import type { Order } from '../domain/models.js';
import { AppError } from '../domain/app-error.js';
import { integer, invariant } from './checked.js';

export interface PlannedFill {
  makerOrderId: string;
  priceCents: number;
  quantity: number;
}

export function isActive(order: Order): boolean {
  return order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED';
}

export function compareOrders(side: Side, left: Order, right: Order): number {
  const price =
    side === 'BUY' ? right.priceCents - left.priceCents : left.priceCents - right.priceCents;
  return price || left.sequence - right.sequence;
}

/** Read-only preflight: do not skip self orders or commit the earlier external fills. */
export function planMatches(
  incoming: Pick<Order, 'userId' | 'side' | 'priceCents' | 'quantity'>,
  makers: readonly Order[],
): PlannedFill[] {
  const fills: PlannedFill[] = [];
  let remaining = incoming.quantity;
  for (const maker of makers) {
    if (remaining === 0) break;
    const crosses =
      incoming.side === 'BUY'
        ? incoming.priceCents >= maker.priceCents
        : incoming.priceCents <= maker.priceCents;
    if (!crosses) break;
    if (maker.userId === incoming.userId) {
      throw new AppError(409, 'SELF_TRADE_PREVENTED', '委托将与自己的挂单成交，请调整价格或数量');
    }
    const makerRemaining = integer(maker.quantity - maker.filledQuantity);
    invariant(makerRemaining > 0);
    const quantity = Math.min(remaining, makerRemaining);
    fills.push({ makerOrderId: maker.id, priceCents: maker.priceCents, quantity });
    remaining -= quantity;
  }
  return fills;
}
