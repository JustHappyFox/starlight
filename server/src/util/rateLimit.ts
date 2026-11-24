/** Простой лимитер фиксированного окна в памяти (один инстанс сервера). */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 50_000) this.gc(now);
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }

  private gc(now: number) {
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
  }
}
