import type { AppContext } from '../context.js';
import type { IncomingTx } from './toncenter.js';
import { dm, notifyAdmins } from '../services/notify.js';
import { formatTon } from '../services/pricing.js';
import { escapeHtml } from '../util/html.js';

const LAST_LT = 'payments:last_lt';
const COMMENT_RE = /SL-[A-Z0-9]{8}/i;
/** Оплата после истечения счёта принимается в течение этого окна (курс мог уйти) */
const LATE_GRACE_MS = 2 * 3_600_000;

/** Опрос входящих транзакций сервисного кошелька и сопоставление со счетами. */
export async function pollPayments(ctx: AppContext): Promise<number> {
  if (!ctx.receiveAddress) return 0;
  const last = BigInt(ctx.repo.getMeta(LAST_LT) ?? '0');
  const fresh: IncomingTx[] = [];
  for (let page = 0; page < 10; page++) {
    const batch = await ctx.toncenter.incoming(ctx.receiveAddress, 100, page * 100);
    const newer = batch.filter((t) => BigInt(t.lt) > last);
    fresh.push(...newer);
    if (batch.length < 100 || newer.length < batch.length) break;
  }
  fresh.sort((a, b) => (BigInt(a.lt) < BigInt(b.lt) ? -1 : 1));
  let processed = 0;
  for (const tx of fresh) {
    await handleTx(ctx, tx);
    ctx.repo.setMeta(LAST_LT, tx.lt);
    processed++;
  }
  return processed;
}

export async function handleTx(ctx: AppContext, tx: IncomingTx) {
  if (tx.aborted || tx.bounced || tx.value <= 0n) return;
  const comment = tx.comment ? (COMMENT_RE.exec(tx.comment)?.[0]?.toUpperCase() ?? null) : null;
  const inv = comment ? ctx.repo.getInvoiceByComment(comment) : undefined;
  const isNew = ctx.repo.insertPayment(
    { tx_hash: tx.hash, lt: tx.lt, invoice_id: inv?.id ?? null, source: tx.source, amount_nano: tx.value.toString(), comment: tx.comment, utime: tx.utime },
    ctx.now(),
  );
  if (!isNew) return;
  if (!inv) {
    if (tx.value >= 100_000_000n) {
      await notifyAdmins(ctx, `💰 Платёж без счёта: ${formatTon(tx.value)} TON от ${escapeHtml(tx.source ?? '?')}\nКомментарий: ${escapeHtml(tx.comment ?? '—')}`);
    }
    return;
  }
  const g = ctx.repo.getGiveaway(inv.giveaway_id);
  if (!g) return;

  const paid = BigInt(inv.paid_nano) + tx.value;
  const due = BigInt(inv.amount_nano);
  if (inv.status === 'paid') {
    await notifyAdmins(ctx, `💰 Переплата по счёту ${inv.id} (${g.id}): +${formatTon(tx.value)} TON`);
    ctx.repo.updateInvoice(inv.id, { paid_nano: paid.toString() });
    return;
  }
  const late = tx.utime * 1000 > inv.expires_at + LATE_GRACE_MS;
  if (paid < due || late) {
    ctx.repo.updateInvoice(inv.id, { paid_nano: paid.toString(), status: 'underpaid' });
    const reason = late ? 'оплата пришла после истечения счёта' : `не хватает ${formatTon(due - paid)} TON`;
    await dm(ctx, g.creator_id, `⚠️ Оплата по розыгрышу <b>${g.id}</b> получена частично: ${escapeHtml(reason)}.` + (late ? ' Поддержка свяжется с вами.' : ' Доплатите по той же ссылке в приложении.'));
    if (late) await notifyAdmins(ctx, `⚠️ Поздняя оплата ${inv.id} (${g.id}): ${formatTon(paid)} TON. Решите вручную: /markpaid ${g.id}`);
    return;
  }
  const now = ctx.now();
  const ok = ctx.repo.tx(() => {
    ctx.repo.updateInvoice(inv.id, { paid_nano: paid.toString(), status: 'paid', paid_at: now });
    return ctx.repo.transitionGiveaway(g.id, 'draft', 'paid', now, { paid_at: now, last_error: null });
  });
  if (!ok) return;
  ctx.log.info({ gid: g.id, invoice: inv.id, nano: paid.toString() }, 'invoice paid');
  await dm(
    ctx,
    g.creator_id,
    `✅ Оплата получена: ${formatTon(paid)} TON.\n\nОсталось опубликовать розыгрыш <b>${g.id}</b> — сейчас или в выбранное время.`,
    {
      inline_keyboard: [
        [{ text: '📣 Опубликовать сейчас', callback_data: `pub:${g.id}` }],
        [{ text: '🗓 Выбрать время', web_app: { url: ctx.links.webApp(`/my/${g.id}`) } }],
      ],
    },
  );
  try {
    await ctx.treasury.onPaymentReceived(paid, `invoice:${inv.id}`);
  } catch (e) {
    ctx.log.error({ err: String(e), invoice: inv.id }, 'treasury hedge failed');
    await notifyAdmins(ctx, `⚠️ Не удалось обменять TON→USDT по счёту ${inv.id}: ${escapeHtml(String(e))}`);
  }
}

/** Ручное подтверждение оплаты админом (поздний платёж и т.п.) */
export function markPaidManually(ctx: AppContext, gid: string): boolean {
  const now = ctx.now();
  const inv = ctx.repo.latestInvoice(gid);
  return ctx.repo.tx(() => {
    if (inv) ctx.repo.updateInvoice(inv.id, { status: 'paid', paid_at: now });
    return ctx.repo.transitionGiveaway(gid, 'draft', 'paid', now, { paid_at: now });
  });
}
