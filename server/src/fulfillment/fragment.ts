import { Cell } from '@ton/core';
import type { Logger } from '../util/logger.js';
import type { WalletLike } from '../ton/wallet.js';
import type { Treasury } from '../treasury/index.js';
import { DeliveryError, type DeliveryRequest, type DeliveryResult, type PrizeProvider } from './provider.js';

/**
 * Выдача Stars/Premium через fragment.com.
 *
 * ВАЖНО: у Fragment НЕТ официального публичного API. Используется тот же внутренний
 * JSON-API, что и сайт (fragment.com/api?hash=...), с cookie сессии, в которой
 * подключён (TON Connect) именно наш сервисный кошелёк. Формат может измениться
 * без предупреждения — см. JOURNAL.md. Получатель ищется ТОЛЬКО по @username.
 *
 * Поток (stars):    searchStarsRecipient → initBuyStarsRequest → getBuyStarsLink → перевод TON
 * Поток (premium):  searchPremiumGiftRecipient → initGiftPremiumRequest → getGiftPremiumLink → перевод TON
 */

type Fetch = typeof fetch;

interface FragmentTx {
  validUntil?: number;
  messages: { address: string; amount: string; payload?: string }[];
}

export interface FragmentOptions {
  cookies: string;
  hash?: string;
  wallet: WalletLike | null;
  treasury: Treasury;
  dryRun: boolean;
  log: Logger;
  fetchFn?: Fetch;
  /** Максимум TON на один приз — защита от ошибки в ответе Fragment */
  maxNanoPerPrize?: bigint;
}

const BASE = 'https://fragment.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class FragmentProvider implements PrizeProvider {
  readonly name = 'fragment';
  private hash: string | null;

  constructor(private o: FragmentOptions) {
    this.hash = o.hash ?? null;
  }

  private get f(): Fetch {
    return this.o.fetchFn ?? fetch;
  }

  private headers(referer: string): Record<string, string> {
    return {
      cookie: this.o.cookies,
      'user-agent': UA,
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      origin: BASE,
      referer: `${BASE}${referer}`,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
  }

  /** hash API берётся со страницы сайта (ajInit({... apiUrl: "/api?hash=..."})) */
  async apiHash(page = '/stars/buy'): Promise<string> {
    if (this.hash) return this.hash;
    const res = await this.f(`${BASE}${page}`, { headers: { cookie: this.o.cookies, 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
    const html = await res.text();
    const m = /api\?hash=([a-f0-9]+)/i.exec(html);
    if (!m) throw new DeliveryError('Fragment: не найден api hash — проверьте FRAGMENT_COOKIES (сессия истекла?)', 'fatal');
    this.hash = m[1]!;
    return this.hash;
  }

  async call<T = Record<string, unknown>>(method: string, params: Record<string, string | number>, referer: string): Promise<T> {
    const hash = await this.apiHash();
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) body.set(k, String(v));
    body.set('method', method);
    const res = await this.f(`${BASE}/api?hash=${hash}`, {
      method: 'POST',
      headers: this.headers(referer),
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new DeliveryError(`Fragment ${method}: HTTP ${res.status}`, 'retry');
    const j = (await res.json()) as Record<string, unknown>;
    if (j.error) {
      const msg = String(j.error);
      if (/session|log ?in|auth|access denied/i.test(msg)) this.hash = null;
      throw new DeliveryError(`Fragment ${method}: ${msg}`, classify(msg));
    }
    return j as T;
  }

  private tonConnectParams() {
    const w = this.o.wallet;
    if (!w) throw new DeliveryError('Fragment: не настроен сервисный кошелёк', 'fatal');
    const device = {
      platform: 'web',
      appName: 'tonkeeper',
      appVersion: '3.0',
      maxProtocolVersion: 2,
      features: ['SendTransaction', { name: 'SendTransaction', maxMessages: 4 }],
    };
    return { account: JSON.stringify(w.tonConnectAccount()), device: JSON.stringify(device) };
  }

  async prepare(req: DeliveryRequest): Promise<{ reqId: string; tx: FragmentTx; recipientName: string | null }> {
    const username = req.username.replace(/^@/, '');
    if (req.type === 'stars') {
      const ref = '/stars/buy';
      const s = await this.call<{ found?: { recipient?: string; name?: string } }>('searchStarsRecipient', { query: username, quantity: req.amount }, ref);
      const recipient = s.found?.recipient;
      if (!recipient) throw new DeliveryError(`Fragment: пользователь @${username} не найден`, 'recipient');
      const init = await this.call<{ req_id?: string }>('initBuyStarsRequest', { recipient, quantity: req.amount }, ref);
      if (!init.req_id) throw new DeliveryError('Fragment: нет req_id', 'retry');
      const link = await this.call<{ transaction?: FragmentTx }>('getBuyStarsLink', { transaction: 1, id: init.req_id, show_sender: 0, ...this.tonConnectParams() }, ref);
      if (!link.transaction?.messages?.length) throw new DeliveryError('Fragment: нет транзакции в ответе', 'retry');
      return { reqId: init.req_id, tx: link.transaction, recipientName: s.found?.name ?? null };
    }
    const ref = '/premium/gift';
    const s = await this.call<{ found?: { recipient?: string; name?: string } }>('searchPremiumGiftRecipient', { query: username, months: req.amount }, ref);
    const recipient = s.found?.recipient;
    if (!recipient) throw new DeliveryError(`Fragment: пользователь @${username} не найден`, 'recipient');
    const init = await this.call<{ req_id?: string }>('initGiftPremiumRequest', { recipient, months: req.amount }, ref);
    if (!init.req_id) throw new DeliveryError('Fragment: нет req_id', 'retry');
    const link = await this.call<{ transaction?: FragmentTx }>('getGiftPremiumLink', { transaction: 1, id: init.req_id, show_sender: 0, ...this.tonConnectParams() }, ref);
    if (!link.transaction?.messages?.length) throw new DeliveryError('Fragment: нет транзакции в ответе', 'retry');
    return { reqId: init.req_id, tx: link.transaction, recipientName: s.found?.name ?? null };
  }

  async deliver(req: DeliveryRequest): Promise<DeliveryResult> {
    const { reqId, tx } = await this.prepare(req);
    const total = tx.messages.reduce((s, m) => s + BigInt(m.amount), 0n);
    const cap = this.o.maxNanoPerPrize ?? 2_000_000_000_000n; // 2000 TON
    if (total <= 0n || total > cap) throw new DeliveryError(`Fragment: подозрительная сумма ${total} nano`, 'fatal');
    for (const m of tx.messages) {
      if (!/^(EQ|UQ|0:|kQ|0Q)/.test(m.address)) throw new DeliveryError(`Fragment: странный адрес получателя ${m.address}`, 'fatal');
    }
    if (this.o.dryRun) {
      this.o.log.info({ ref: req.ref, reqId, totalNano: total.toString(), to: tx.messages.map((m) => m.address) }, 'fragment[dry-run]: перевод не отправлен');
      return { providerRef: `dry:${reqId}`, costNano: total.toString() };
    }
    await this.o.treasury.ensureTon(total, req.ref);
    const wallet = this.o.wallet!;
    const { seqno } = await wallet.send(
      tx.messages.map((m) => ({ to: m.address, value: BigInt(m.amount), body: m.payload ? Cell.fromBase64(fixBase64(m.payload)) : undefined })),
      `fragment ${req.type} ${req.ref}`,
    );
    return { providerRef: reqId, txRef: `seqno:${seqno}`, costNano: total.toString() };
  }
}

function classify(msg: string): DeliveryError['kind'] {
  if (/not found|no telegram users|user.*(not|n't)|invalid username|recipient/i.test(msg)) return 'recipient';
  if (/already|cannot gift|can't gift|not available/i.test(msg)) return 'fatal';
  return 'retry';
}

/** Fragment отдаёт payload иногда в base64url без паддинга */
function fixBase64(s: string): string {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return b;
}
