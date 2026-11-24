import { Cell } from '@ton/core';
import type { Logger } from '../util/logger.js';
import type { WalletLike } from '../ton/wallet.js';
import type { Treasury } from '../treasury/index.js';
import { DeliveryError, type DeliveryRequest, type DeliveryResult, type PrizeProvider } from './provider.js';
import { DEVICE, type FragmentSession } from './fragmentSession.js';

/**
 * Выдача Stars/Premium через fragment.com (внутренний API сайта — официального нет).
 * Получатель ищется ТОЛЬКО по публичному @username (или ссылке t.me/<username>).
 *
 * Поток (сверен с github.com/S1qwy/fragment-api-py, methods/purchases.py):
 *  update<…>State(mode=new) → search<…>Recipient → init<…>Request(payment_method=ton)
 *  → get<…>Link(account, device, transaction=1) → перевод TON → confirmReq(boc) → опрос update<…>State до mode=done
 */

interface FragmentTx {
  validUntil?: number;
  messages: { address: string; amount: string; payload?: string }[];
  confirm_method?: string;
  confirm_params?: Record<string, string | number>;
}

const FLOWS = {
  stars: { page: '/stars/buy', state: 'updateStarsBuyState', search: 'searchStarsRecipient', init: 'initBuyStarsRequest', link: 'getBuyStarsLink' },
  premium: { page: '/premium/gift', state: 'updatePremiumState', search: 'searchPremiumGiftRecipient', init: 'initGiftPremiumRequest', link: 'getGiftPremiumLink' },
} as const;

export interface FragmentOptions {
  session: FragmentSession;
  wallet: WalletLike | null;
  treasury: Treasury;
  dryRun: boolean;
  log: Logger;
  /** Максимум TON на один приз — защита от ошибки в ответе Fragment */
  maxNanoPerPrize?: bigint;
  confirmTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const dh = () => String(BigInt(Date.now()) * 1_000_000n);

export class FragmentProvider implements PrizeProvider {
  readonly name = 'fragment';

  constructor(private o: FragmentOptions) {}

  private sleep(ms: number) {
    return (this.o.sleep ?? ((t: number) => new Promise((r) => setTimeout(r, t))))(ms);
  }

  private async recipient(type: DeliveryRequest['type'], username: string, amount: number) {
    const fl = FLOWS[type];
    const s = this.o.session;
    await s.call(fl.state, { mode: 'new', lv: 'false', dh: dh() }, fl.page);
    const query = username.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
    const res = await s.call<{ found?: { recipient?: string; name?: string } }>(
      fl.search,
      type === 'stars' ? { query, quantity: '' } : { query, months: amount },
      fl.page,
    );
    const recipient = res.found?.recipient;
    if (!recipient) throw new DeliveryError(`Fragment: пользователь @${query} не найден`, 'recipient');
    return { recipient, name: res.found?.name ?? `@${query}` };
  }

  async lookup(req: Omit<DeliveryRequest, 'ref'>): Promise<{ name: string }> {
    return this.o.session.authed(async () => ({ name: (await this.recipient(req.type, req.username, req.amount)).name }));
  }

  async deliver(req: DeliveryRequest): Promise<DeliveryResult> {
    return this.o.session.authed(() => this.deliverOnce(req));
  }

  private async deliverOnce(req: DeliveryRequest): Promise<DeliveryResult> {
    const fl = FLOWS[req.type];
    const s = this.o.session;
    const w = this.o.wallet;
    if (!w) throw new DeliveryError('Fragment: не настроен сервисный кошелёк', 'fatal');
    const { recipient } = await this.recipient(req.type, req.username, req.amount);
    const init = await s.call<{ req_id?: string }>(
      fl.init,
      req.type === 'stars' ? { recipient, quantity: req.amount, payment_method: 'ton' } : { recipient, months: req.amount, payment_method: 'ton' },
      fl.page,
    );
    const reqId = init.req_id;
    if (!reqId) throw new DeliveryError('Fragment: нет req_id', 'retry');
    const account = JSON.stringify(w.tonConnectAccount());
    const link = await s.call<{ transaction?: FragmentTx; evm?: unknown }>(
      fl.link,
      { account, device: DEVICE, transaction: 1, id: reqId, show_sender: 0 },
      fl.page,
    );
    const tx = link.transaction;
    if (link.evm || !tx?.messages?.length) throw new DeliveryError('Fragment: нет TON-транзакции в ответе', 'retry');

    const total = tx.messages.reduce((sum, m) => sum + BigInt(m.amount), 0n);
    const cap = this.o.maxNanoPerPrize ?? 2_000_000_000_000n; // 2000 TON
    if (total <= 0n || total > cap) throw new DeliveryError(`Fragment: подозрительная сумма ${total} nano`, 'fatal');
    for (const m of tx.messages) {
      if (!/^(EQ|UQ|0:|kQ|0Q)/.test(m.address)) throw new DeliveryError(`Fragment: странный адрес получателя ${m.address}`, 'fatal');
    }
    if (this.o.dryRun) {
      this.o.log.info({ ref: req.ref, reqId, totalNano: total.toString(), to: tx.messages.map((m) => m.address) }, 'fragment[dry-run]: перевод не отправлен');
      return { providerRef: `dry:${reqId}`, costNano: total.toString(), confirmed: false };
    }

    await this.o.treasury.ensureTon(total, req.ref);
    const { seqno, boc } = await w.send(
      tx.messages.map((m) => ({ to: m.address, value: BigInt(m.amount), body: m.payload ? Cell.fromBase64(fixBase64(m.payload)) : undefined })),
      `fragment ${req.type} ${req.ref}`,
    );
    // деньги ушли — дальше ошибки не должны приводить к повторной оплате
    const confirmed = await this.confirm(fl, tx, reqId, account, boc).catch((e) => {
      this.o.log.warn({ ref: req.ref, reqId, err: String(e) }, 'fragment: подтверждение не получено');
      return false;
    });
    return { providerRef: reqId, txRef: `seqno:${seqno}`, costNano: total.toString(), confirmed };
  }

  /** Сообщить Fragment подписанную транзакцию и дождаться выполнения заказа */
  private async confirm(fl: (typeof FLOWS)[keyof typeof FLOWS], tx: FragmentTx, reqId: string, account: string, boc: string): Promise<boolean> {
    const s = this.o.session;
    await s.call(tx.confirm_method || 'confirmReq', { ...(tx.confirm_params ?? { id: reqId }), account, device: DEVICE, boc }, fl.page);
    const deadline = Date.now() + (this.o.confirmTimeoutMs ?? 180_000);
    let mode = 'new';
    while (Date.now() < deadline) {
      const r = await s.call<{ mode?: string; need_update?: boolean; req_id?: string; id?: string }>(fl.state, { id: reqId, mode, lv: 'false', dh: dh() }, fl.page);
      mode = r.mode ?? mode;
      if (mode === 'done' && r.need_update === false) return String(r.req_id ?? r.id ?? reqId) === reqId;
      await this.sleep(3000);
    }
    return false;
  }
}

/** Fragment отдаёт payload иногда в base64url без паддинга */
function fixBase64(s: string): string {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return b;
}
