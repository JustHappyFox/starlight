import { Bot, InlineKeyboard } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { AppContext } from '../context.js';
import { onBotMembership } from './channels.js';
import { applyContact } from '../services/giveaways.js';
import { parseStartParam } from '../services/links.js';
import { isAdmin } from '../services/notify.js';
import { requeueWinner, stuckProcessing } from '../fulfillment/queue.js';
import { markPaidManually } from '../ton/payments.js';
import { schedulePublish } from '../services/scheduler.js';
import { AppError, claimPrize } from '../services/giveaways.js';
import { escapeHtml } from '../util/html.js';
import { formatTon } from '../services/pricing.js';

export function createBot(token: string): Bot {
  const bot = new Bot(token);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  return bot;
}

export function registerHandlers(bot: Bot, ctx: AppContext) {
  const { repo, links } = ctx;

  bot.use(async (c, next) => {
    if (c.from && !c.from.is_bot) {
      const existing = repo.getUser(c.from.id);
      repo.upsertUser(
        {
          id: c.from.id,
          username: c.from.username ?? null,
          first_name: c.from.first_name,
          last_name: c.from.last_name ?? null,
          language_code: c.from.language_code ?? null,
          is_premium: !!c.from.is_premium,
          // написал боту в личку — значит, бот может ему писать
          allows_pm: c.chat?.type === 'private' || !!existing?.allows_pm,
        },
        ctx.now(),
      );
    }
    await next();
  });

  bot.command('start', async (c) => {
    if (c.chat.type !== 'private') return;
    const sp = parseStartParam(c.match);
    if (sp) {
      const kb = new InlineKeyboard().webApp('🎁 Открыть розыгрыш', links.webApp(`/g/${sp.gid}${sp.ref ? `?ref=${sp.ref}` : ''}`));
      await c.reply('Нажмите кнопку, чтобы открыть розыгрыш:', { reply_markup: kb });
      return;
    }
    const kb = new InlineKeyboard()
      .webApp('🚀 Открыть приложение', links.webApp('/'))
      .row()
      .url('➕ Подключить канал', links.connectChannel());
    await c.reply(
      [
        '<b>Розыгрыши Telegram Stars и Premium</b>',
        '',
        '1. Подключите канал — добавьте бота администратором (кнопка ниже).',
        '2. В приложении настройте приз, сроки, страны и защиту от ботов.',
        '3. Оплатите призы в TON — бот опубликует пост с кнопкой участия.',
        '4. В конце бот честно выберет победителей и сам отправит им призы.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: kb },
    );
  });

  bot.command('help', (c) =>
    c.reply('Откройте приложение кнопкой меню. Канал подключается добавлением бота в администраторы с правом публикации и редактирования сообщений.'),
  );

  // Бот добавлен в канал / права изменены
  bot.on('my_chat_member', async (c) => {
    const upd = c.myChatMember;
    await onBotMembership(ctx, upd.chat as never, upd.from.id, upd.new_chat_member as never);
    if (upd.chat.type === 'channel' && upd.new_chat_member.status === 'administrator') {
      const ch = repo.getChannel(upd.chat.id);
      const ok = ch?.bot_can_post && ch?.bot_can_edit;
      await c.api
        .sendMessage(
          upd.from.id,
          ok
            ? `✅ Канал «${escapeHtml(ch!.title)}» подключён. Теперь его можно выбрать при создании розыгрыша.`
            : `⚠️ Бот добавлен в «${escapeHtml(upd.chat.title ?? '')}», но без прав на публикацию/редактирование. Выдайте их в настройках администратора.`,
          { parse_mode: 'HTML' },
        )
        .catch(() => undefined);
    }
  });

  // Контакт, отправленный через requestContact в мини-аппе, приходит и сюда
  bot.on('message:contact', async (c) => {
    const country = applyContact(ctx, c.from.id, c.message.contact);
    if (country === null) return;
    await c.reply(country === 'XX' ? 'Не удалось определить страну по номеру.' : `Страна подтверждена: ${country}. Вернитесь в приложение.`, {
      reply_markup: { remove_keyboard: true },
    });
  });

  // «📣 Опубликовать сейчас» из сообщения об оплате
  bot.callbackQuery(/^pub:([A-Za-z0-9]+)$/, async (c) => {
    try {
      const g = await schedulePublish(ctx, c.from.id, c.match[1]!, null);
      if (g.status === 'active') {
        await c.answerCallbackQuery({ text: '📣 Опубликовано!' });
        await c.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      } else {
        await c.answerCallbackQuery({ text: g.last_error ? `Не удалось: ${g.last_error}`.slice(0, 190) : 'Публикуем…', show_alert: !!g.last_error });
      }
    } catch (e) {
      await c.answerCallbackQuery({ text: e instanceof AppError ? e.message.slice(0, 190) : 'Ошибка, попробуйте в приложении', show_alert: true });
    }
  });

  // «Я поставил username» из сообщения победителю
  bot.callbackQuery(/^claim:([A-Za-z0-9]+)$/, async (c) => {
    const gid = c.match[1]!;
    const g = repo.getGiveaway(gid);
    const user = repo.getUser(c.from.id);
    if (!g || !user) return c.answerCallbackQuery({ text: 'Приз не найден' });
    if (!c.from.username) return c.answerCallbackQuery({ text: 'Username всё ещё не установлен. Или укажите другой аккаунт в приложении.', show_alert: true });
    try {
      await claimPrize(ctx, g, user, null);
      await c.answerCallbackQuery({ text: 'Отправляем приз — это займёт пару минут' });
    } catch (e) {
      await c.answerCallbackQuery({ text: e instanceof AppError ? e.message.slice(0, 190) : 'Ошибка, попробуйте в приложении', show_alert: true });
    }
  });

  const admin = bot.filter((c) => !!c.from && isAdmin(ctx, c.from.id) && c.chat?.type === 'private');

  // ---------- вход в Fragment (вместо ручных куки) ----------
  const fragmentStatus = () => {
    const f = ctx.fragment;
    if (!f) return 'Выдача через Fragment выключена (FULFILLMENT_PROVIDER).';
    const s = f.state;
    const yes = (b: boolean) => (b ? '✅' : '❌');
    return [
      '<b>Fragment</b>',
      `${yes(s.wallet)} вход кошельком (обновляется автоматически)`,
      `${yes(s.telegram)} вход Telegram-аккаунтом`,
      s.lastCheckAt ? `${s.lastCheckOk ? '✅' : '⚠️'} проверка ${new Date(s.lastCheckAt).toISOString().slice(0, 16).replace('T', ' ')} UTC${s.lastError ? `: ${escapeHtml(s.lastError)}` : ''}` : '— проверки ещё не было',
      ctx.cfg.FULFILLMENT_DRY_RUN ? '\n🧪 FULFILLMENT_DRY_RUN=true — переводы не отправляются' : '',
    ].join('\n');
  };
  const fragmentKb = () =>
    new InlineKeyboard().text('🔑 Войти через Telegram', 'fraglogin').row().text('🔄 Проверить', 'fragcheck');

  admin.command('fragment', async (c) => {
    await c.reply(fragmentStatus(), { parse_mode: 'HTML', reply_markup: ctx.fragment ? fragmentKb() : undefined });
  });

  let loginRunning = false;
  bot.callbackQuery('fraglogin', async (c) => {
    if (!isAdmin(ctx, c.from.id) || !ctx.fragment) return c.answerCallbackQuery();
    if (loginRunning) return c.answerCallbackQuery({ text: 'Вход уже идёт — подтвердите его в Telegram' });
    await c.answerCallbackQuery({ text: 'Готовим вход…' });
    loginRunning = true;
    const chatId = c.from.id;
    let msgId: number | null = null;
    void ctx.fragment
      .telegramLogin(async (link) => {
        const text = '🔑 <b>Вход в Fragment</b>\n\nНажмите кнопку и подтвердите вход в Telegram (тем аккаунтом, к которому привязан Fragment). Ссылка действует несколько минут.';
        const kb = new InlineKeyboard().url('✅ Подтвердить вход', link);
        if (msgId) await c.api.editMessageText(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => undefined);
        else msgId = (await c.api.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb })).message_id;
      })
      .then(async () => {
        const ok = await ctx.fragment!.healthCheck(ctx.cfg.FRAGMENT_HEALTH_USERNAME, ctx.now());
        await c.api.sendMessage(chatId, ok ? '✅ Fragment подключён, выдача призов продолжится автоматически.' : `⚠️ Вход выполнен, но проверка не прошла:\n${escapeHtml(ctx.fragment!.state.lastError ?? '')}`, { parse_mode: 'HTML' });
      })
      .catch(async (e) => {
        await c.api.sendMessage(chatId, `❌ Вход не выполнен: ${escapeHtml(String((e as Error)?.message ?? e))}`, { parse_mode: 'HTML' });
      })
      .finally(() => {
        loginRunning = false;
      });
  });

  bot.callbackQuery('fragcheck', async (c) => {
    if (!isAdmin(ctx, c.from.id) || !ctx.fragment) return c.answerCallbackQuery();
    await c.answerCallbackQuery({ text: 'Проверяем…' });
    await ctx.fragment.healthCheck(ctx.cfg.FRAGMENT_HEALTH_USERNAME, ctx.now());
    await c.editMessageText(fragmentStatus(), { parse_mode: 'HTML', reply_markup: fragmentKb() }).catch(() => undefined);
  });

  // ---------- админ ----------

  admin.command('stats', async (c) => {
    const s = repo.stats();
    const wallet = ctx.wallet ? await ctx.wallet.balance().then(formatTon).catch(() => '?') : '—';
    await c.reply(
      [
        `👤 Пользователей: ${s.users}`,
        `🎁 Активных: ${s.giveawaysActive}, завершено: ${s.giveawaysFinished}`,
        `🙋 Участий: ${s.participants}, банов: ${s.bans}`,
        `💵 Выручка: $${(s.revenueUsdCents / 100).toFixed(2)}, оценка себестоимости: $${(s.costEstimateUsdCents / 100).toFixed(2)}`,
        `📦 Призы: отправлено ${s.prizesSent}, в очереди ${s.prizesPending}, ошибок ${s.prizesFailed}`,
        `👛 Кошелёк: ${wallet} TON`,
        `⚙️ Выдача: ${ctx.provider.name}${ctx.cfg.FULFILLMENT_DRY_RUN ? ' (dry-run)' : ''}, казначейство: ${ctx.cfg.TREASURY_MODE}${ctx.cfg.TREASURY_DRY_RUN ? ' (dry-run)' : ''}`,
      ].join('\n'),
    );
  });

  admin.command('failed', async (c) => {
    const rows = [...repo.winnersByStatus('failed'), ...stuckProcessing(ctx)].slice(0, 30);
    if (!rows.length) return c.reply('Проблемных выдач нет.');
    await c.reply(rows.map((w) => `${w.giveaway_id} / ${w.user_id}: ${w.status} — ${w.last_error ?? ''}`).join('\n'));
  });

  admin.command('retry', async (c) => {
    const [gid, uidRaw, force] = (c.match ?? '').split(/\s+/);
    if (!gid) return c.reply('/retry <gid> [uid] [force]');
    const list = uidRaw ? [Number(uidRaw)] : repo.listWinners(gid).map((w) => w.user_id);
    const n = list.filter((uid) => requeueWinner(ctx, gid, uid, force === 'force')).length;
    await c.reply(`В очередь возвращено: ${n}`);
  });

  admin.command('markpaid', async (c) => {
    const gid = (c.match ?? '').trim();
    await c.reply(markPaidManually(ctx, gid) ? `✅ ${gid} помечен оплаченным` : 'Не получилось (статус не draft?)');
  });

  admin.command('refunds', async (c) => {
    const r = repo.openRefunds();
    if (!r.length) return c.reply('Открытых возвратов нет.');
    await c.reply(r.map((x) => `#${x.id} ${x.giveaway_id}: $${(x.usd_cents / 100).toFixed(2)} — ${x.reason}`).join('\n'));
  });

  admin.command('unban', async (c) => {
    const uid = Number((c.match ?? '').trim());
    if (!uid) return c.reply('/unban <user_id>');
    repo.removeBans(uid);
    repo.setGlobalBan(uid, false);
    await c.reply(`Пользователь ${uid} разбанен`);
  });

  bot.catch((err) => ctx.log.error({ err: String(err.error) }, 'bot error'));
}
