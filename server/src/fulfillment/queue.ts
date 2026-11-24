import type { AppContext } from '../context.js';
import type { WinnerRow } from '../db/repo.js';
import { DeliveryError } from './provider.js';
import { dm, notifyAdmins } from '../services/notify.js';
import { prizeLabel } from '../services/post.js';
import { escapeHtml } from '../util/html.js';

const HOUR = 3_600_000;

function backoff(attempts: number): number {
  return Math.min(6 * HOUR, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** Актуальный username: getChat отдаёт свежий, если пользователь сменил его после участия */
async function currentUsername(ctx: AppContext, userId: number): Promise<string | null> {
  try {
    const chat = (await ctx.tg.getChat(userId)) as { username?: string };
    if (chat.username) {
      const u = ctx.repo.getUser(userId);
      if (u && u.username !== chat.username) ctx.repo.upsertUser({ ...u, username: chat.username, is_premium: !!u.is_premium, allows_pm: !!u.allows_pm }, ctx.now());
      return chat.username;
    }
  } catch {
    /* бот мог не «видеть» пользователя — используем сохранённый */
  }
  return ctx.repo.getUser(userId)?.username ?? null;
}

/**
 * Выдаёт призы по одному (кошелёк требует строгой последовательности переводов).
 * Возвращает число обработанных записей.
 */
export async function processDeliveries(ctx: AppContext, limit = 5): Promise<number> {
  const due = ctx.repo.dueWinners(ctx.now(), limit);
  let n = 0;
  for (const w of due) {
    if (!ctx.repo.claimWinner(w.giveaway_id, w.user_id, ctx.now())) continue;
    n++;
    await deliverOne(ctx, w);
  }
  return n;
}

async function deliverOne(ctx: AppContext, w: WinnerRow) {
  const g = ctx.repo.getGiveaway(w.giveaway_id);
  if (!g) return;
  const now = ctx.now();
  const prize = escapeHtml(prizeLabel(g.prize_type, g.prize_amount));
  const claimDeadline = w.created_at + ctx.cfg.CLAIM_WINDOW_DAYS * 24 * HOUR;

  const username = await currentUsername(ctx, w.user_id);
  if (!username) {
    if (now > claimDeadline) {
      ctx.repo.updateWinner(w.giveaway_id, w.user_id, { status: 'failed', last_error: 'нет username: истёк срок получения' }, now);
      await notifyAdmins(ctx, `❗ Приз не выдан (нет username, срок истёк): ${g.id} / ${w.user_id}`);
      return;
    }
    ctx.repo.updateWinner(w.giveaway_id, w.user_id, { status: 'needs_username', next_attempt_at: now + 6 * HOUR, last_error: 'нет username' }, now);
    if (!w.notified) {
      const sent = await dm(
        ctx,
        w.user_id,
        `🎁 Вы выиграли ${prize}, но у вашего аккаунта нет публичного @username — без него приз отправить нельзя.\n\nУстановите username в настройках Telegram и нажмите кнопку ниже.`,
        { inline_keyboard: [[{ text: '✅ Username установлен — получить приз', callback_data: `claim:${g.id}` }]] },
      );
      if (sent) ctx.repo.updateWinner(w.giveaway_id, w.user_id, { notified: 1 }, now);
    }
    return;
  }

  try {
    const res = await ctx.provider.deliver({ type: g.prize_type, amount: g.prize_amount, username, ref: `${g.id}:${w.user_id}` });
    ctx.repo.updateWinner(
      w.giveaway_id,
      w.user_id,
      { status: 'sent', username_used: username, provider_ref: res.providerRef, tx_ref: res.txRef ?? null, cost_nano: res.costNano ?? null, last_error: null, attempts: w.attempts + 1 },
      ctx.now(),
    );
    await dm(ctx, w.user_id, `✅ Приз отправлен: ${prize} → @${escapeHtml(username)}.\nСпасибо за участие!`);
  } catch (e) {
    const err = e instanceof DeliveryError ? e : new DeliveryError(String((e as Error)?.message ?? e), 'retry');
    const attempts = w.attempts + 1;
    ctx.log.warn({ gid: g.id, uid: w.user_id, kind: err.kind, err: err.message, attempts }, 'delivery failed');
    if (err.kind === 'recipient' && now < claimDeadline) {
      ctx.repo.updateWinner(w.giveaway_id, w.user_id, { status: 'needs_username', attempts, last_error: err.message, next_attempt_at: now + 6 * HOUR, notified: 0 }, now);
      return;
    }
    if (err.kind === 'fatal' || attempts >= ctx.cfg.FULFILLMENT_MAX_ATTEMPTS || now > claimDeadline) {
      ctx.repo.updateWinner(w.giveaway_id, w.user_id, { status: 'failed', attempts, last_error: err.message }, now);
      await notifyAdmins(ctx, `❗ Приз не выдан: ${g.id} / ${w.user_id}\n${escapeHtml(err.message)}\nПовтор: /retry ${g.id}`);
      return;
    }
    ctx.repo.updateWinner(w.giveaway_id, w.user_id, { status: 'pending', attempts, last_error: err.message, next_attempt_at: now + backoff(attempts) }, now);
  }
}

/** Повторить выдачу (после смены username или исправления ошибки) */
export function requeueWinner(ctx: AppContext, gid: string, uid: number, force = false): boolean {
  const w = ctx.repo.getWinner(gid, uid);
  if (!w || w.status === 'sent') return false;
  // processing после падения: перевод мог уйти — повтор только вручную после проверки кошелька
  if (w.status === 'processing' && !force) return false;
  ctx.repo.updateWinner(gid, uid, { status: 'pending', next_attempt_at: 0, attempts: w.status === 'failed' ? 0 : w.attempts }, ctx.now());
  return true;
}

/** Записи, зависшие в processing после падения процесса — вернуть в очередь вручную после проверки кошелька */
export function stuckProcessing(ctx: AppContext): WinnerRow[] {
  return ctx.repo.winnersByStatus('processing');
}
