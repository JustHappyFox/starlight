import { GrammyError } from 'grammy';
import type { AppContext } from '../context.js';
import type { ChannelRow } from '../db/repo.js';
import { AppError } from '../services/giveaways.js';

interface MemberLike {
  status: string;
  can_post_messages?: boolean;
  can_edit_messages?: boolean;
}

export function botRights(m: MemberLike) {
  const isAdmin = m.status === 'administrator';
  return { post: isAdmin && m.can_post_messages !== false, edit: isAdmin && m.can_edit_messages !== false };
}

/** Бота добавили/изменили права в канале (update my_chat_member) */
export async function onBotMembership(
  ctx: AppContext,
  chat: { id: number; type: string; title?: string; username?: string },
  fromUserId: number,
  member: MemberLike,
) {
  if (chat.type !== 'channel') return;
  const now = ctx.now();
  const rights = botRights(member);
  const active = member.status === 'administrator';
  ctx.repo.upsertChannel({ id: chat.id, title: chat.title ?? 'Канал', username: chat.username ?? null, bot_can_post: rights.post, bot_can_edit: rights.edit, active }, now);
  if (!active) return;
  // привязываем канал к тому, кто добавил бота, — только если он сам админ канала
  try {
    const m = await ctx.tg.getChatMember(chat.id, fromUserId);
    if (m.status === 'creator' || m.status === 'administrator') ctx.repo.addChannelManager(chat.id, fromUserId, now);
  } catch (e) {
    ctx.log.warn({ chat: chat.id, err: String(e) }, 'cannot verify channel admin');
  }
}

/** Привязка канала, где бот уже админ, по @username */
export async function linkChannelByUsername(ctx: AppContext, userId: number, raw: string): Promise<ChannelRow> {
  const username = raw.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{4,32}$/.test(username)) throw new AppError('bad_request', 'Укажите @username канала');
  let chat: { id: number; type: string; title?: string; username?: string };
  try {
    chat = (await ctx.tg.getChat(`@${username}`)) as typeof chat;
  } catch (e) {
    if (e instanceof GrammyError) throw new AppError('bad_request', 'Канал не найден или бот не добавлен в него');
    throw e;
  }
  if (chat.type !== 'channel') throw new AppError('bad_request', 'Это не канал');
  const me = await ctx.tg.getMe();
  const botMember = await ctx.tg.getChatMember(chat.id, me.id).catch(() => null);
  if (!botMember || botMember.status !== 'administrator') throw new AppError('channel_not_ready', 'Сначала добавьте бота администратором канала');
  const userMember = await ctx.tg.getChatMember(chat.id, userId).catch(() => null);
  if (!userMember || (userMember.status !== 'creator' && userMember.status !== 'administrator'))
    throw new AppError('forbidden', 'Вы не администратор этого канала', 403);
  const rights = botRights(botMember as MemberLike);
  const now = ctx.now();
  ctx.repo.upsertChannel({ id: chat.id, title: chat.title ?? username, username: chat.username ?? null, bot_can_post: rights.post, bot_can_edit: rights.edit, active: true }, now);
  ctx.repo.addChannelManager(chat.id, userId, now);
  return ctx.repo.getChannel(chat.id)!;
}
