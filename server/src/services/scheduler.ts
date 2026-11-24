import type { AppContext } from '../context.js';
import type { GiveawayRow } from '../db/repo.js';
import { buttonMarkup, renderPost } from './post.js';
import { drawGiveaway } from './draw.js';
import { processDeliveries } from '../fulfillment/queue.js';
import { pollPayments } from '../ton/payments.js';
import { dm, notifyAdmins } from './notify.js';
import { escapeHtml } from '../util/html.js';
import { AppError, getOwnGiveaway } from './giveaways.js';
import { formatDate } from './post.js';

/** Оплаченный, но так и не опубликованный розыгрыш: отмена и возврат */
async function cancelUnpublished(ctx: AppContext, g: GiveawayRow, from: 'paid' | 'scheduled', reason: string) {
  const now = ctx.now();
  if (!ctx.repo.transitionGiveaway(g.id, from, 'cancelled', now, { last_error: reason })) return;
  ctx.repo.insertRefund({ giveaway_id: g.id, reason, usd_cents: g.price_usd_cents }, now);
  await dm(ctx, g.creator_id, `❌ Розыгрыш <b>${g.id}</b> не опубликован до даты окончания (${escapeHtml(reason)}). Оформлен возврат — поддержка свяжется с вами.`);
  await notifyAdmins(ctx, `💸 Возврат: ${g.id} не опубликован (${escapeHtml(reason)}). /refunds`);
}

/**
 * Организатор после оплаты нажал «Опубликовать»: сейчас (at = null) или в выбранное время
 * (at — миллисекунды UTC, получены из времени на телефоне организатора).
 * Можно вызывать повторно, пока пост не вышел: перенести время или опубликовать сразу.
 */
export async function schedulePublish(ctx: AppContext, userId: number, gid: string, at: number | null): Promise<GiveawayRow> {
  const g = getOwnGiveaway(ctx, userId, gid);
  if (g.status === 'draft') throw new AppError('not_paid', 'Сначала оплатите розыгрыш', 409);
  if (g.status !== 'paid' && g.status !== 'scheduled') throw new AppError('locked', 'Розыгрыш уже опубликован', 409);
  const now = ctx.now();
  if (at !== null && (!Number.isFinite(at) || at < now - 60_000)) throw new AppError('bad_request', 'Это время уже прошло — выберите время в будущем');
  const when = at === null || at < now ? now : at;
  const minMs = ctx.cfg.MIN_DURATION_MINUTES * 60_000;
  if (g.ends_at - when < minMs) {
    throw new AppError(
      'bad_request',
      `Публикация должна быть хотя бы за ${ctx.cfg.MIN_DURATION_MINUTES} мин до подведения итогов (${formatDate(g.ends_at, g.timezone)})`,
    );
  }
  const ch = g.channel_id !== null ? ctx.repo.getChannel(g.channel_id) : undefined;
  if (!ch?.active || !ch.bot_can_post) throw new AppError('channel_not_ready', 'Бот не может публиковать в канале — проверьте его права администратора');
  if (!ctx.repo.transitionGiveaway(gid, g.status, 'scheduled', now, { starts_at: when, last_error: null })) {
    throw new AppError('locked', 'Статус розыгрыша изменился — обновите страницу', 409);
  }
  const fresh = ctx.repo.getGiveaway(gid)!;
  if (when <= now) await publishGiveaway(ctx, fresh);
  return ctx.repo.getGiveaway(gid)!;
}

/**
 * Розыгрыши, которые прямо сейчас отправляются в канал. Кнопка «Опубликовать сейчас» и тик
 * планировщика могут сработать одновременно — без блокировки в канале появится два поста.
 */
const publishing = new Set<string>();

/** Публикация розыгрыша в канал (статус scheduled, время starts_at наступило) */
export async function publishGiveaway(ctx: AppContext, g: GiveawayRow): Promise<boolean> {
  if (publishing.has(g.id)) return false;
  publishing.add(g.id);
  try {
    // статус перечитываем под блокировкой: другой вызов мог уже опубликовать
    const fresh = ctx.repo.getGiveaway(g.id);
    return fresh ? await publishLocked(ctx, fresh) : false;
  } finally {
    publishing.delete(g.id);
  }
}

async function publishLocked(ctx: AppContext, g: GiveawayRow): Promise<boolean> {
  const now = ctx.now();
  if (g.status !== 'scheduled') return false;
  if (g.starts_at && g.starts_at > now) return false;
  if (g.ends_at <= now + 60_000) {
    await cancelUnpublished(ctx, g, 'scheduled', 'не удалось опубликовать до окончания');
    return false;
  }
  if (g.channel_id === null) return false;
  try {
    const msg = await ctx.tg.sendMessage(g.channel_id, renderPost(g), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: buttonMarkup(ctx, g, 'active'),
    });
    const ok = ctx.repo.transitionGiveaway(g.id, 'scheduled', 'active', ctx.now(), {
      post_message_id: msg.message_id,
      published_at: ctx.now(),
      button_count: g.participants_count,
      button_phase: 'active',
      button_updated_at: ctx.now(),
      last_error: null,
    });
    if (ok) {
      const ch = ctx.repo.getChannel(g.channel_id);
      const url = ch ? ctx.links.channelPost(ch, msg.message_id) : '';
      await dm(ctx, g.creator_id, `📣 Розыгрыш опубликован${url ? `: ${url}` : ''}`);
    }
    return ok;
  } catch (e) {
    const err = String((e as Error)?.message ?? e);
    if (g.last_error !== err) {
      ctx.repo.updateGiveaway(g.id, { last_error: err }, ctx.now());
      await dm(
        ctx,
        g.creator_id,
        `⚠️ Не получается опубликовать розыгрыш <b>${g.id}</b>: ${escapeHtml(err)}\n\nПроверьте, что бот — администратор канала с правом публикации и редактирования сообщений. Повторяем автоматически.`,
      );
    }
    ctx.log.warn({ gid: g.id, err }, 'publish failed');
    return false;
  }
}

/** Обновление счётчика участников на кнопке (не чаще BUTTON_UPDATE_INTERVAL_SEC) */
export async function refreshButton(ctx: AppContext, g: GiveawayRow) {
  if (!g.show_counter || g.channel_id === null || !g.post_message_id) return;
  const now = ctx.now();
  if (g.button_count === g.participants_count) return;
  if (now - g.button_updated_at < ctx.cfg.BUTTON_UPDATE_INTERVAL_SEC * 1000) return;
  try {
    await ctx.tg.editMessageReplyMarkup(g.channel_id, g.post_message_id, { reply_markup: buttonMarkup(ctx, g, 'active') });
  } catch (e) {
    if (!String(e).includes('message is not modified')) ctx.log.warn({ gid: g.id, err: String(e) }, 'button refresh failed');
  }
  ctx.repo.updateGiveaway(g.id, { button_count: g.participants_count, button_updated_at: now }, now);
}

/** Проверка сессии Fragment; если умерла и не восстановилась сама — кнопка входа админам (не чаще раза в 6 ч) */
async function checkFragment(ctx: AppContext) {
  const f = ctx.fragment!;
  if (await f.healthCheck(ctx.cfg.FRAGMENT_HEALTH_USERNAME, ctx.now())) return;
  const key = 'alert:fragment_auth';
  if (ctx.now() - Number(ctx.repo.getMeta(key) ?? 0) < 6 * 3_600_000) return;
  ctx.repo.setMeta(key, String(ctx.now()));
  await notifyAdmins(ctx, `🔑 Fragment: сессия не работает — выдача призов на паузе.\n${escapeHtml(f.state.lastError ?? '')}`, {
    inline_keyboard: [[{ text: '🔑 Войти в Fragment', callback_data: 'fraglogin' }]],
  });
}

export interface SchedulerHandle {
  stop(): void;
  tick(): Promise<void>;
}

export function startScheduler(ctx: AppContext, opts: { autoStart?: boolean } = {}): SchedulerHandle {
  let running = false;
  let lastPaymentPoll = 0;
  let lastFragmentCheck = 0;
  let timer: NodeJS.Timeout | null = null;

  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      ctx.log.error({ step: name, err: String((e as Error)?.stack ?? e) }, 'scheduler step failed');
    }
  };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = ctx.now();
      if (now - lastPaymentPoll >= ctx.cfg.PAYMENT_POLL_SEC * 1000) {
        lastPaymentPoll = now;
        await step('payments', () => pollPayments(ctx));
      }
      await step('expire-invoices', async () => {
        ctx.repo.db.prepare(`UPDATE invoices SET status = 'expired' WHERE status = 'pending' AND paid_nano = '0' AND expires_at < ?`).run(now);
      });
      for (const g of ctx.repo.listByStatus('paid')) {
        // оплачен, но организатор так и не нажал «Опубликовать», а времени уже не хватает
        if (g.ends_at - ctx.now() < ctx.cfg.MIN_DURATION_MINUTES * 60_000)
          await step(`expire:${g.id}`, () => cancelUnpublished(ctx, g, 'paid', 'не нажата публикация'));
      }
      for (const g of ctx.repo.listByStatus('scheduled')) await step(`publish:${g.id}`, () => publishGiveaway(ctx, g));
      for (const g of ctx.repo.listByStatus('active')) {
        if (g.ends_at <= ctx.now()) await step(`draw:${g.id}`, () => drawGiveaway(ctx, g.id));
        else await step(`button:${g.id}`, () => refreshButton(ctx, g));
      }
      for (const g of ctx.repo.listByStatus('drawing')) await step(`redraw:${g.id}`, () => drawGiveaway(ctx, g.id));
      if (ctx.fragment && now - lastFragmentCheck >= ctx.cfg.FRAGMENT_HEALTH_INTERVAL_MIN * 60_000) {
        lastFragmentCheck = now;
        await step('fragment-health', () => checkFragment(ctx));
      }
      await step('deliveries', () => processDeliveries(ctx));
      await step('purge', async () => ctx.repo.purgeCaptchas(now - 3_600_000));
    } finally {
      running = false;
    }
  };

  if (opts.autoStart !== false) {
    timer = setInterval(() => void tick(), ctx.cfg.SCHEDULER_TICK_SEC * 1000);
    void tick();
  }
  return {
    tick,
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
