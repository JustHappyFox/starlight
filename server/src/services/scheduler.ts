import type { AppContext } from '../context.js';
import type { GiveawayRow } from '../db/repo.js';
import { buttonMarkup, renderPost } from './post.js';
import { drawGiveaway } from './draw.js';
import { processDeliveries } from '../fulfillment/queue.js';
import { pollPayments } from '../ton/payments.js';
import { dm, notifyAdmins } from './notify.js';
import { escapeHtml } from '../util/html.js';

/** Публикация оплаченного розыгрыша в канал */
export async function publishGiveaway(ctx: AppContext, g: GiveawayRow): Promise<boolean> {
  const now = ctx.now();
  if (g.status !== 'scheduled') return false;
  if (g.starts_at && g.starts_at > now) return false;
  if (g.ends_at <= now + 60_000) {
    // не успели опубликовать до конца — возврат
    if (ctx.repo.transitionGiveaway(g.id, 'scheduled', 'cancelled', now, { last_error: 'не удалось опубликовать до окончания' })) {
      ctx.repo.insertRefund({ giveaway_id: g.id, reason: 'не опубликован до даты окончания', usd_cents: g.price_usd_cents }, now);
      await dm(ctx, g.creator_id, `❌ Розыгрыш <b>${g.id}</b> не удалось опубликовать до даты окончания. Оформлен возврат — поддержка свяжется с вами.`);
      await notifyAdmins(ctx, `💸 Возврат: ${g.id} не опубликован. /refunds`);
    }
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

export interface SchedulerHandle {
  stop(): void;
  tick(): Promise<void>;
}

export function startScheduler(ctx: AppContext, opts: { autoStart?: boolean } = {}): SchedulerHandle {
  let running = false;
  let lastPaymentPoll = 0;
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
      for (const g of ctx.repo.listByStatus('scheduled')) await step(`publish:${g.id}`, () => publishGiveaway(ctx, g));
      for (const g of ctx.repo.listByStatus('active')) {
        if (g.ends_at <= ctx.now()) await step(`draw:${g.id}`, () => drawGiveaway(ctx, g.id));
        else await step(`button:${g.id}`, () => refreshButton(ctx, g));
      }
      for (const g of ctx.repo.listByStatus('drawing')) await step(`redraw:${g.id}`, () => drawGiveaway(ctx, g.id));
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
