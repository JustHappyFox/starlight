import type { AppContext } from '../context.js';
import type { GiveawayRow, WinnerIssue, WinnerRow } from '../db/repo.js';
import { DeliveryError } from './provider.js';
import { dm, notifyAdmins } from '../services/notify.js';
import { formatDate, prizeLabel } from '../services/post.js';
import { escapeHtml } from '../util/html.js';
import { redrawGiveaway } from '../services/draw.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function backoff(attempts: number): number {
  return Math.min(6 * HOUR, 60_000 * 2 ** Math.max(0, attempts - 1));
}

export function claimDeadline(ctx: AppContext, w: Pick<WinnerRow, 'created_at'>): number {
  return w.created_at + ctx.cfg.CLAIM_WINDOW_DAYS * DAY;
}

/** Актуальный username: getChat отдаёт свежий, если пользователь сменил его после участия */
export async function currentUsername(ctx: AppContext, userId: number): Promise<string | null> {
  try {
    const chat = (await ctx.tg.getChat(userId)) as { username?: string };
    const u = ctx.repo.getUser(userId);
    if (u && (chat.username ?? null) !== u.username) {
      ctx.repo.upsertUser({ ...u, username: chat.username ?? null, is_premium: !!u.is_premium, allows_pm: !!u.allows_pm }, ctx.now());
    }
    return chat.username ?? null;
  } catch {
    /* бот мог не «видеть» пользователя — используем сохранённый */
  }
  return ctx.repo.getUser(userId)?.username ?? null;
}

const ISSUE_TEXT: Record<WinnerIssue, string> = {
  no_username: 'У вашего аккаунта нет публичного @username, а без него приз отправить нельзя.',
  not_found: 'Не удалось найти аккаунт получателя по username.',
  ineligible: 'Этот аккаунт не может принять приз — например, у него уже активен Telegram Premium.',
};

function claimKeyboard(ctx: AppContext, g: GiveawayRow, issue: WinnerIssue) {
  const rows: ({ text: string; web_app: { url: string } } | { text: string; callback_data: string })[][] = [
    [{ text: '🎁 Получить приз', web_app: { url: ctx.links.webApp(`/g/${g.id}`) } }],
  ];
  if (issue === 'no_username') rows.push([{ text: '✅ Я поставил username', callback_data: `claim:${g.id}` }]);
  return { inline_keyboard: rows };
}

/** Приз ждёт действия победителя: поставить ник или указать другой аккаунт */
async function waitForRecipient(ctx: AppContext, g: GiveawayRow, w: WinnerRow, issue: WinnerIssue, detail?: string) {
  const now = ctx.now();
  const deadline = claimDeadline(ctx, w);
  ctx.repo.updateWinner(g.id, w.user_id, { status: 'needs_username', issue, recipient: null, last_error: detail ?? ISSUE_TEXT[issue], next_attempt_at: now + 6 * HOUR }, now);
  if (w.issue === issue && w.notified) return;
  const sent = await dm(
    ctx,
    w.user_id,
    `🎉 Вы выиграли ${escapeHtml(prizeLabel(g.prize_type, g.prize_amount))}!\n\n${ISSUE_TEXT[issue]}\n\n` +
      `Как получить:\n• поставьте себе @username и нажмите кнопку, или\n• укажите в приложении другой аккаунт (например, друга) — приз уйдёт туда.\n\n` +
      `⏳ Срок: до ${escapeHtml(formatDate(deadline, g.timezone))}. Потом приз будет разыгран заново.`,
    claimKeyboard(ctx, g, issue),
  );
  if (sent) ctx.repo.updateWinner(g.id, w.user_id, { notified: 1 }, now);
}

/** Срок вышел — приз доразыгрывается (честно, продолжением того же случайного потока) */
async function expire(ctx: AppContext, g: GiveawayRow, w: WinnerRow) {
  ctx.repo.updateWinner(g.id, w.user_id, { status: 'unclaimed', last_error: 'не забран в срок' }, ctx.now());
  await dm(ctx, w.user_id, `⌛ Срок получения приза в розыгрыше <b>${g.id}</b> истёк — приз разыгран заново.`);
  await redrawGiveaway(ctx, g.id);
}

/** Победитель ждёт: истёк ли срок, не появился ли ник, пора ли напомнить */
async function checkWaiting(ctx: AppContext, g: GiveawayRow, w: WinnerRow) {
  const now = ctx.now();
  const deadline = claimDeadline(ctx, w);
  if (now > deadline) return expire(ctx, g, w);
  if (w.issue === 'no_username' && !w.recipient && (await currentUsername(ctx, w.user_id))) {
    ctx.repo.updateWinner(g.id, w.user_id, { status: 'pending', issue: null, next_attempt_at: 0 }, now);
    return;
  }
  let reminded = !!w.reminded;
  if (!reminded && now > deadline - DAY) {
    await dm(ctx, w.user_id, `⏰ Остались сутки, чтобы получить приз (${escapeHtml(prizeLabel(g.prize_type, g.prize_amount))}). Иначе он будет разыгран заново.`, claimKeyboard(ctx, g, w.issue ?? 'no_username'));
    reminded = true;
  }
  // следующая проверка: через 6 ч, но не позже момента напоминания и окончания срока
  let next = now + 6 * HOUR;
  if (!reminded) next = Math.min(next, Math.max(now + 60_000, deadline - DAY));
  next = Math.min(next, deadline + 1);
  ctx.repo.updateWinner(g.id, w.user_id, { next_attempt_at: next, reminded: reminded ? 1 : 0 }, now);
}

async function alertFragmentAuth(ctx: AppContext, err: string) {
  const key = 'alert:fragment_auth';
  const last = Number(ctx.repo.getMeta(key) ?? 0);
  if (ctx.now() - last < 6 * HOUR) return;
  ctx.repo.setMeta(key, String(ctx.now()));
  await notifyAdmins(ctx, `🔑 Fragment: нужен вход, выдача призов на паузе.\n${escapeHtml(err)}\n\nНажмите кнопку — подтвердите вход в Telegram.`, {
    inline_keyboard: [[{ text: '🔑 Войти в Fragment', callback_data: 'fraglogin' }]],
  });
}

/**
 * Выдаёт призы по одному (кошелёк требует строгой последовательности переводов).
 * Возвращает число обработанных записей.
 */
export async function processDeliveries(ctx: AppContext, limit = 5): Promise<number> {
  const due = ctx.repo.dueWinners(ctx.now(), limit);
  let n = 0;
  for (const w of due) {
    const g = ctx.repo.getGiveaway(w.giveaway_id);
    if (!g) continue;
    n++;
    if (w.status === 'needs_username') {
      await checkWaiting(ctx, g, w);
      continue;
    }
    if (!ctx.repo.claimWinner(w.giveaway_id, w.user_id, ctx.now())) continue;
    await deliverOne(ctx, g, w);
  }
  return n;
}

async function deliverOne(ctx: AppContext, g: GiveawayRow, w: WinnerRow) {
  const now = ctx.now();
  const prize = escapeHtml(prizeLabel(g.prize_type, g.prize_amount));
  const target = w.recipient ?? (await currentUsername(ctx, w.user_id));
  if (!target) return waitForRecipient(ctx, g, w, 'no_username');

  try {
    const res = await ctx.provider.deliver({ type: g.prize_type, amount: g.prize_amount, username: target, ref: `${g.id}:${w.user_id}` });
    ctx.repo.updateWinner(
      w.giveaway_id,
      w.user_id,
      {
        status: 'sent',
        issue: null,
        username_used: target,
        provider_ref: res.providerRef,
        tx_ref: res.txRef ?? null,
        cost_nano: res.costNano ?? null,
        last_error: res.confirmed === false ? 'оплачено, Fragment ещё не подтвердил выполнение' : null,
        attempts: w.attempts + 1,
      },
      ctx.now(),
    );
    const own = !w.recipient;
    await dm(ctx, w.user_id, `✅ Приз отправлен: ${prize} → @${escapeHtml(target)}.${own ? '' : ' (указанный вами аккаунт)'}\nСпасибо за участие!`);
  } catch (e) {
    const err = e instanceof DeliveryError ? e : new DeliveryError(String((e as Error)?.message ?? e), 'retry');
    const attempts = w.attempts + 1;
    ctx.log.warn({ gid: g.id, uid: w.user_id, kind: err.kind, err: err.message, attempts }, 'delivery failed');
    if (err.kind === 'auth') {
      // проблема с нашей сессией, а не с призом: попытку не считаем
      ctx.repo.updateWinner(w.giveaway_id, w.user_id, { status: 'pending', last_error: err.message, next_attempt_at: now + 10 * 60_000 }, now);
      await alertFragmentAuth(ctx, err.message);
      return;
    }
    if (err.kind === 'recipient' || err.kind === 'ineligible') {
      return waitForRecipient(ctx, g, { ...w, attempts }, err.kind === 'recipient' ? 'not_found' : 'ineligible', err.message);
    }
    if (err.kind === 'fatal' || attempts >= ctx.cfg.FULFILLMENT_MAX_ATTEMPTS) {
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
  if (!w || w.status === 'sent' || w.status === 'unclaimed') return false;
  // processing после падения: перевод мог уйти — повтор только вручную после проверки кошелька
  if (w.status === 'processing' && !force) return false;
  ctx.repo.updateWinner(gid, uid, { status: 'pending', issue: null, next_attempt_at: 0, attempts: w.status === 'failed' ? 0 : w.attempts }, ctx.now());
  return true;
}

/** Записи, зависшие в processing после падения процесса — вернуть в очередь вручную после проверки кошелька */
export function stuckProcessing(ctx: AppContext): WinnerRow[] {
  return ctx.repo.winnersByStatus('processing');
}
