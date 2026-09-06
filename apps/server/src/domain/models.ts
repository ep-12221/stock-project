import type { OrderDto, PublicTradeDto } from '@stock/shared';

interface UserBase {
  id: string;
  username: string;
  createdAt: string;
}
export interface HumanUser extends UserBase {
  kind: 'USER';
  passwordHash: string;
  passwordSalt: string;
}
export interface SystemUser extends UserBase {
  kind: 'SYSTEM';
}
export type User = HumanUser | SystemUser;

export interface Account {
  userId: string;
  cashBalanceCents: number;
  frozenCashCents: number;
  version: number;
}
export interface Position {
  userId: string;
  symbol: string;
  quantity: number;
  frozenQuantity: number;
}
export interface Session {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}
export interface Order extends OrderDto {
  userId: string;
}
export interface Trade extends PublicTradeDto {
  buyOrderId: string;
  sellOrderId: string;
  buyerUserId: string;
  sellerUserId: string;
}
export interface OrderBook {
  buyOrderIds: string[];
  sellOrderIds: string[];
}

/** Successful public commands retained for this store's lifetime. */
export interface IdempotentOrder {
  readonly orderId: string;
  readonly fingerprint: string;
}
