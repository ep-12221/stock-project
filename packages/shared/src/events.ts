import type { AccountStateDto, MarketSnapshot } from './dto.js';

interface Envelope<T extends string, P> {
  type: T;
  serverEpoch: string;
  emittedAt: string;
  payload: P;
}

// Private frames carry the account owner and process identity as well as the version.
export type RealtimeEvent =
  | Envelope<'state.snapshot', { market: MarketSnapshot; account: AccountStateDto }>
  | Envelope<'market.updated', MarketSnapshot>
  | Envelope<'account.updated', AccountStateDto>;
