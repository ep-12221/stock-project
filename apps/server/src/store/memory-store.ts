import { randomUUID } from 'node:crypto';
import { STOCKS, type StockQuote } from '@stock/shared';
import type {
  Account,
  IdempotentOrder,
  Order,
  OrderBook,
  Position,
  Session,
  Trade,
  User,
} from '../domain/models.js';
import { seedStore } from './seed.js';

export interface MemoryStore {
  serverEpoch: string;
  now: () => number;
  users: Map<string, User>;
  usernames: Map<string, string>;
  accounts: Map<string, Account>;
  positions: Map<string, Map<string, Position>>;
  sessions: Map<string, Session>;
  stocks: Map<string, StockQuote>;
  marketVersion: number;
  orders: Map<string, Order>;
  idempotentOrdersByUser: Map<string, Map<string, IdempotentOrder>>;
  orderBooks: Map<string, OrderBook>;
  ordersByUser: Map<string, string[]>;
  activeOrdersByUser: Map<string, Set<string>>;
  trades: Map<string, Trade>;
  tradesByUser: Map<string, string[]>;
  marketTradeIds: string[];
  orderSequence: number;
  tradeSequence: number;
  activeOrderCount: number;
  liquiditySeeded: boolean;
}

export function createMemoryStore(options: { now?: () => number } = {}): MemoryStore {
  const store: MemoryStore = {
    serverEpoch: randomUUID(),
    now: options.now ?? Date.now,
    users: new Map(),
    usernames: new Map(),
    accounts: new Map(),
    positions: new Map(),
    sessions: new Map(),
    stocks: new Map(),
    marketVersion: 0,
    orders: new Map(),
    idempotentOrdersByUser: new Map(),
    orderBooks: new Map(
      STOCKS.map(({ symbol }) => [symbol, { buyOrderIds: [], sellOrderIds: [] }]),
    ),
    ordersByUser: new Map(),
    activeOrdersByUser: new Map(),
    trades: new Map(),
    tradesByUser: new Map(),
    marketTradeIds: [],
    orderSequence: 0,
    tradeSequence: 0,
    activeOrderCount: 0,
    liquiditySeeded: false,
  };
  seedStore(store);
  return store;
}
