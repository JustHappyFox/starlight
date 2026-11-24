import type { Logger } from '../util/logger.js';

export interface RateProvider {
  tonUsd(): Promise<number>;
}

type Fetch = typeof fetch;

/** Курс TON/USD с несколькими источниками и кэшем. */
export class MarketRates implements RateProvider {
  private cached: { rate: number; at: number } | null = null;

  constructor(
    private opts: { override?: number; fetchFn?: Fetch; log: Logger; ttlMs?: number; staleMs?: number },
  ) {}

  async tonUsd(): Promise<number> {
    if (this.opts.override && this.opts.override > 0) return this.opts.override;
    const ttl = this.opts.ttlMs ?? 60_000;
    const stale = this.opts.staleMs ?? 15 * 60_000;
    const now = Date.now();
    if (this.cached && now - this.cached.at < ttl) return this.cached.rate;
    const f = this.opts.fetchFn ?? fetch;
    const sources: [string, () => Promise<number>][] = [
      ['tonapi', async () => {
        const r = await f('https://tonapi.io/v2/rates?tokens=ton&currencies=usd', { signal: AbortSignal.timeout(5000) });
        const j = (await r.json()) as { rates?: { TON?: { prices?: { USD?: number } } } };
        return Number(j.rates?.TON?.prices?.USD);
      }],
      ['coingecko', async () => {
        const r = await f('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd', { signal: AbortSignal.timeout(5000) });
        const j = (await r.json()) as Record<string, { usd?: number }>;
        return Number(j['the-open-network']?.usd);
      }],
    ];
    for (const [name, get] of sources) {
      try {
        const rate = await get();
        if (Number.isFinite(rate) && rate > 0) {
          this.cached = { rate, at: now };
          return rate;
        }
      } catch (e) {
        this.opts.log.warn({ err: String(e), source: name }, 'rate source failed');
      }
    }
    if (this.cached && now - this.cached.at < stale) return this.cached.rate;
    throw new Error('Не удалось получить курс TON/USD');
  }
}
