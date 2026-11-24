import { GrammyError } from 'grammy';
import type { AppContext } from '../context.js';

type Markup = { inline_keyboard: ({ text: string; url: string } | { text: string; callback_data: string } | { text: string; web_app: { url: string } })[][] };

/** Сообщение в личку. Не бросает: пользователь мог не запускать бота или заблокировать его. */
export async function dm(ctx: AppContext, userId: number, html: string, markup?: Markup): Promise<boolean> {
  try {
    await ctx.tg.sendMessage(userId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(markup ? { reply_markup: markup } : {}),
    });
    return true;
  } catch (e) {
    if (e instanceof GrammyError && (e.error_code === 403 || e.error_code === 400)) {
      if (e.error_code === 403) ctx.repo.setAllowsPm(userId, false);
      return false;
    }
    ctx.log.warn({ err: String(e), userId }, 'dm failed');
    return false;
  }
}

export async function notifyAdmins(ctx: AppContext, html: string) {
  for (const id of ctx.cfg.ADMIN_IDS) await dm(ctx, id, html);
}

export function isAdmin(ctx: AppContext, userId: number) {
  return ctx.cfg.ADMIN_IDS.includes(userId);
}
