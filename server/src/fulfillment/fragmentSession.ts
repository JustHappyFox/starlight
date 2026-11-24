import type { Repo } from '../db/repo.js';
import type { Logger } from '../util/logger.js';
import type { WalletLike } from '../ton/wallet.js';
import { DeliveryError } from './provider.js';

/**
 * Сессия fragment.com без ручного копирования куки.
 *
 * Fragment пускает к покупкам только сессию с двумя входами:
 *  1. Кошелёк (кука stel_ton_token) — TON Connect ton_proof. Сервер подписывает его своим ключом
 *     САМ, без участия человека: walletLogin().
 *  2. Telegram-аккаунт (кука stel_token) — OAuth на oauth.telegram.org (клиент Fragment). Сервер
 *     получает ссылку t.me/oauth?startapp=…, админ один раз жмёт «Подтвердить» в Telegram:
 *     telegramLogin(). Сессия живёт долго; если отвалится — бот пришлёт кнопку входа снова.
 * Все куки из ответов (Set-Cookie) сохраняются в БД, так что перезапуск сервера сессию не теряет.
 *
 * Протокол сверен с открытым клиентом github.com/S1qwy/fragment-api-py (см. JOURNAL.md).
 */

type Fetch = typeof fetch;

export const FRAGMENT = 'https://fragment.com';
const OAUTH = 'https://oauth.telegram.org';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
/** Описание «кошелька» для Fragment — как у Tonkeeper */
export const DEVICE = JSON.stringify({
  platform: 'android',
  appName: 'Tonkeeper',
  appVersion: '26.07.1',
  maxProtocolVersion: 2,
  features: ['SendTransaction', { name: 'SignData', types: ['text', 'binary', 'cell'] }, { name: 'SendTransaction', maxMessages: 255 }],
});
const OAUTH_PARAMS = new URLSearchParams({
  client_id: '5444323279',
  origin: FRAGMENT,
  return_to: `${FRAGMENT}/`,
  scope: 'openid profile telegram:bot_access',
  redirect_uri: `${FRAGMENT}/`,
  response_type: 'post_message',
}).toString();
const META_KEY = 'fragment:cookies';

export class CookieJar {
  private map = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    for (const [k, v] of Object.entries(initial ?? {})) this.map.set(k, v);
  }

  static parseHeader(header: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  get(name: string): string | undefined {
    return this.map.get(name);
  }

  set(name: string, value: string) {
    this.map.set(name, value);
  }

  /** Применить Set-Cookie из ответа. true — что-то изменилось */
  absorb(res: Response): boolean {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    let changed = false;
    for (const sc of list) {
      const [pair, ...attrs] = sc.split(';');
      const i = pair!.indexOf('=');
      if (i <= 0) continue;
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      const expired =
        value === '' ||
        value === 'deleted' ||
        attrs.some((a) => /^\s*max-age\s*=\s*(0|-)/i.test(a)) ||
        attrs.some((a) => {
          const m = /^\s*expires\s*=\s*(.+)$/i.exec(a);
          return !!m && Date.parse(m[1]!) < Date.now();
        });
      if (expired) changed = this.map.delete(name) || changed;
      else if (this.map.get(name) !== value) {
        this.map.set(name, value);
        changed = true;
      }
    }
    return changed;
  }

  header(): string {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

/** JSON-объект — первый аргумент вызова вида `Wallet.init({...})` на странице */
export function embeddedObject(html: string, marker: string): Record<string, unknown> | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  let i = html.indexOf('{', at + marker.length);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  let inStr: string | null = null;
  for (; i < html.length; i++) {
    const ch = html[i]!;
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function classifyFragmentError(msg: string): DeliveryError['kind'] {
  if (/log ?in|session|access denied|not authori|unauthori|auth/i.test(msg)) return 'auth';
  if (/not found|no telegram users|invalid username|user.*(not|n't) (exist|found)/i.test(msg)) return 'recipient';
  if (/already|cannot (receive|gift)|can't (receive|gift)|ineligible|not available for/i.test(msg)) return 'ineligible';
  return 'retry';
}

export interface SessionStatus {
  wallet: boolean;
  telegram: boolean;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
}

export class FragmentSession {
  private jar: CookieJar;
  private hash: string | null = null;
  private loginLock: Promise<unknown> = Promise.resolve();
  readonly state: SessionStatus = { wallet: false, telegram: false, lastCheckAt: null, lastCheckOk: null, lastError: null };

  constructor(
    private o: {
      repo: Repo;
      wallet: WalletLike | null;
      log: Logger;
      fetchFn?: Fetch;
      /** Куки из env как стартовые (необязательно) */
      seedCookies?: string;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    const saved = o.repo.getMeta(META_KEY);
    const initial = saved ? (JSON.parse(saved) as Record<string, string>) : o.seedCookies ? CookieJar.parseHeader(o.seedCookies) : {};
    this.jar = new CookieJar(initial);
    this.refreshFlags();
  }

  private get f(): Fetch {
    return this.o.fetchFn ?? fetch;
  }

  private sleep(ms: number) {
    return (this.o.sleep ?? ((t: number) => new Promise((r) => setTimeout(r, t))))(ms);
  }

  private refreshFlags() {
    this.state.wallet = !!this.jar.get('stel_ton_token');
    this.state.telegram = !!this.jar.get('stel_token');
  }

  private persist() {
    this.o.repo.setMeta(META_KEY, JSON.stringify(this.jar.toJSON()));
    this.refreshFlags();
  }

  private absorb(res: Response) {
    if (this.jar.absorb(res)) this.persist();
  }

  /** Страница Fragment: заодно обновляет hash API и куки */
  async page(path = '/'): Promise<string> {
    if (!this.jar.get('stel_dt')) this.jar.set('stel_dt', '-180');
    const res = await this.f(`${FRAGMENT}${path}`, {
      headers: { cookie: this.jar.header(), 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(20_000),
    });
    this.absorb(res);
    if (!res.ok) throw new DeliveryError(`Fragment: страница ${path} — HTTP ${res.status}`, 'retry');
    const html = await res.text();
    const m = /api\?hash=([a-f0-9]+)/i.exec(html);
    if (m) this.hash = m[1]!;
    return html;
  }

  async call<T = Record<string, unknown>>(method: string, params: Record<string, string | number>, referer = '/'): Promise<T> {
    if (!this.hash) await this.page(referer);
    if (!this.hash) throw new DeliveryError('Fragment: не найден hash API на странице', 'retry');
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) body.set(k, String(v));
    body.set('method', method);
    const res = await this.f(`${FRAGMENT}/api?hash=${this.hash}`, {
      method: 'POST',
      headers: {
        cookie: this.jar.header(),
        'user-agent': UA,
        accept: 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        origin: FRAGMENT,
        referer: `${FRAGMENT}${referer}`,
        'x-requested-with': 'XMLHttpRequest',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(25_000),
    });
    this.absorb(res);
    if (res.status === 401 || res.status === 403) throw new DeliveryError(`Fragment ${method}: HTTP ${res.status} (нужен вход)`, 'auth');
    if (!res.ok) throw new DeliveryError(`Fragment ${method}: HTTP ${res.status}`, 'retry');
    const j = (await res.json().catch(() => ({ error: 'не JSON-ответ' }))) as Record<string, unknown>;
    if (j.error) {
      const msg = String(j.error);
      const kind = classifyFragmentError(msg);
      if (kind === 'auth') this.hash = null;
      throw new DeliveryError(`Fragment ${method}: ${msg}`, kind);
    }
    return j as T;
  }

  /** Вход кошельком (ton_proof) — полностью автоматический */
  async walletLogin(): Promise<void> {
    const w = this.o.wallet;
    if (!w) throw new DeliveryError('Fragment: для входа нужен сервисный кошелёк (TON_WALLET_MNEMONIC)', 'fatal');
    const run = async () => {
      const html = await this.page('/');
      const init = embeddedObject(html, 'Wallet.init(');
      const challenge = init && typeof init.ton_proof === 'string' ? init.ton_proof : null;
      if (!challenge) throw new DeliveryError('Fragment: на странице нет ton_proof (изменился сайт?)', 'retry');
      const proof = w.tonProof('fragment.com', challenge);
      await this.call('checkTonProofAuth', { account: JSON.stringify(w.tonConnectAccount()), device: DEVICE, proof: JSON.stringify(proof) }, '/');
      if (!this.jar.get('stel_ton_token')) throw new DeliveryError('Fragment: вход кошельком не дал stel_ton_token', 'retry');
      this.o.log.info('fragment: wallet session refreshed');
    };
    const p = this.loginLock.then(run, run);
    this.loginLock = p.catch(() => undefined);
    return p;
  }

  /**
   * Вход Telegram-аккаунтом. onLink вызывается со ссылкой t.me/oauth (и снова, если Telegram её обновил).
   * Промис завершается после подтверждения в Telegram или по таймауту.
   */
  async telegramLogin(onLink: (link: string) => Promise<void> | void, timeoutMs = 5 * 60_000): Promise<void> {
    if (!this.state.wallet) await this.walletLogin();
    const oauth = new CookieJar();
    const get = async (url: string, init: RequestInit = {}) => {
      const res = await this.f(url, {
        ...init,
        headers: { cookie: oauth.header(), 'user-agent': UA, origin: OAUTH, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(20_000),
      });
      oauth.absorb(res);
      if (!res.ok) throw new DeliveryError(`Telegram OAuth: HTTP ${res.status}`, 'retry');
      return res;
    };
    const page = await (await get(`${OAUTH}/auth/auth?${OAUTH_PARAMS}&quick_auth=new`)).text();
    let token = /setToken\(['"]([^'"]+)['"]\)/.exec(page)?.[1];
    if (!token) throw new DeliveryError('Telegram OAuth: не найден токен входа', 'retry');
    await onLink(`https://t.me/oauth?startapp=${token}`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = (await (await get(`${OAUTH}/auth/login?${OAUTH_PARAMS}&qtoken=${encodeURIComponent(token)}`, { method: 'POST', body: '' })).json()) as {
        status?: string;
        qtoken?: string;
      };
      if (r.status === 'refresh' && r.qtoken && r.qtoken !== token) {
        token = r.qtoken;
        await onLink(`https://t.me/oauth?startapp=${token}`);
      } else if (r.status === 'confirmed') {
        const pushed = await (await get(`${OAUTH}/auth/push?${OAUTH_PARAMS}`)).text();
        const auth = /tgAuthResult=([A-Za-z0-9_-]+)/.exec(pushed)?.[1];
        if (!auth) throw new DeliveryError('Telegram OAuth: не найден результат входа', 'retry');
        await this.call('logIn', { auth }, '/');
        if (!this.jar.get('stel_token')) throw new DeliveryError('Fragment: вход Telegram не дал stel_token', 'retry');
        this.o.log.info('fragment: telegram session established');
        return;
      } else if (r.status && ['expired', 'declined', 'cancelled'].includes(r.status)) {
        throw new DeliveryError(`Вход отменён (${r.status})`, 'fatal');
      }
      await this.sleep(1500);
    }
    throw new DeliveryError('Вход не подтверждён за 5 минут', 'fatal');
  }

  /**
   * Вызов с самовосстановлением: при ошибке авторизации — перевход кошельком и один повтор.
   * Если не хватает именно Telegram-входа — ошибка 'auth' (бот попросит админа нажать кнопку).
   */
  async authed<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.state.telegram) throw new DeliveryError('Fragment: не выполнен вход Telegram — /fragment в боте', 'auth');
    if (!this.state.wallet) await this.walletLogin();
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof DeliveryError) || e.kind !== 'auth') throw e;
      await this.walletLogin();
      return await fn();
    }
  }

  /** Проверка, что сессия жива: лёгкий поиск получателя */
  async healthCheck(username: string, now = Date.now()): Promise<boolean> {
    try {
      await this.authed(async () => {
        await this.call('updateStarsBuyState', { mode: 'new', lv: 'false', dh: String(Date.now() * 1e6) }, '/stars/buy');
        await this.call('searchStarsRecipient', { query: username, quantity: '' }, '/stars/buy');
      });
      Object.assign(this.state, { lastCheckAt: now, lastCheckOk: true, lastError: null });
      return true;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      // «получатель не найден» — значит, сама сессия работает
      const ok = e instanceof DeliveryError && (e.kind === 'recipient' || e.kind === 'ineligible');
      Object.assign(this.state, { lastCheckAt: now, lastCheckOk: ok, lastError: ok ? null : msg });
      return ok;
    }
  }

  logout() {
    this.jar = new CookieJar();
    this.hash = null;
    this.persist();
  }
}
