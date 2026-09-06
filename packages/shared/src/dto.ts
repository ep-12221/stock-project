export type Side = 'BUY' | 'SELL';
export type OrderStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED';

export interface ApiSuccess<T> {
  data: T;
}

export interface HealthDto {
  status: 'ok';
  service: '@stock/server';
  serverTime: string;
}

export interface StockDefinition {
  symbol: string;
  name: string;
  initialPriceCents: number;
}

export interface StockQuote {
  symbol: string;
  name: string;
  previousCloseCents: number;
  lastPriceCents: number;
  changePercent: number;
  bestBidCents: number | null;
  bestAskCents: number | null;
  updatedAt: string;
}

export interface UserDto {
  id: string;
  username: string;
}

export interface AccountDto {
  cashBalanceCents: number;
  frozenCashCents: number;
  availableCashCents: number;
}

export interface PositionDto {
  symbol: string;
  quantity: number;
  frozenQuantity: number;
  availableQuantity: number;
}

export interface OrderDto {
  id: string;
  symbol: string;
  side: Side;
  priceCents: number;
  quantity: number;
  filledQuantity: number;
  executedValueCents: number;
  status: OrderStatus;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicTradeDto {
  id: string;
  sequence: number;
  symbol: string;
  priceCents: number;
  quantity: number;
  executedAt: string;
}

export interface PersonalTradeDto extends PublicTradeDto {
  side: Side;
  orderId: string;
}

export interface AccountSnapshot {
  accountVersion: number;
  account: AccountDto;
  positions: PositionDto[];
  activeOrders: OrderDto[];
  recentClosedOrders: OrderDto[];
  recentTrades: PersonalTradeDto[];
}

export interface MarketSnapshot {
  marketVersion: number;
  quotes: StockQuote[];
  recentTrades: PublicTradeDto[];
}

export interface CreateOrderRequest {
  symbol: string;
  side: Side;
  priceCents: number;
  quantity: number;
  clientOrderId: string;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: number | null;
}

export interface AuthDto {
  user: UserDto;
  serverEpoch: string;
  expiresAt: string;
}
export interface AuthCredentials {
  username: string;
  password: string;
}
export interface AccountStateDto extends AccountSnapshot {
  serverEpoch: string;
  userId: string;
}
export interface StocksDto {
  serverEpoch: string;
  marketVersion: number;
  quotes: StockQuote[];
}

export interface CreateOrderResponse {
  order: OrderDto;
  snapshot: AccountStateDto;
}

export interface UserHistoryDto<T> extends Paginated<T> {
  serverEpoch: string;
  userId: string;
  accountVersion: number;
}
export type OrderHistoryDto = UserHistoryDto<OrderDto>;
export type PersonalTradeHistoryDto = UserHistoryDto<PersonalTradeDto>;
export interface MarketTradeHistoryDto extends Paginated<PublicTradeDto> {
  serverEpoch: string;
  marketVersion: number;
}
