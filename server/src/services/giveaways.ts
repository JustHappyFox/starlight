import { z } from 'zod';
import { GrammyError } from 'grammy';
import type { AppContext } from '../context.js';
import type { GiveawayRow, InvoiceRow, UserRow } from '../db/repo.js';
import type {
  ApiErrorCode,
  GiveawayInput,
  GiveawayOwnerView,
  InvoiceView,
  JoinRequest,
  Phase,
  PublicGiveawayView,
  WinnerView,
} from '../../../shared/types.js';
import { BUTTON_TEXT_MAX, POST_TEXT_MAX } from '../config.js';
import { randomId, randomSeed, sha256Hex } from '../util/ids.js';
import { visibleLength } from '../util/html.js';
import { PricingError, quote, unitCostCents, unitPriceCents, formatTon } from './pricing.js';
import { countryFromPhone, isCountryAllowed, normalizeCountries } from './geo.js';
import { countryList } from './post.js';
import { parseStartParam } from './links.js';
import { commentPayload, tonTransferLink } from '../ton/comment.js';

export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const inputSchema = z.object({
  prizeType: z.enum(['stars', 'premium']),
  prizeAmount: z.number().int(),
  winnersCount: z.number().int().min(1),
  startsAt: z.number().int().nullable(),
  endsAt: z.number().int(),
  countries: z.array(z.string().max(3)).max(260).nullable(),
  captcha: z.boolean(),
  honeypot: z.boolean(),
  requireSubscription: z.boolean(),
  publishResults: z.boolean(),
  showCounter: z.boolean(),
  buttonText: z.string().trim().min(1).max(BUTTON_TEXT_MAX),
  postText: z.string().max(POST_TEXT_MAX * 2),
  channelId: z.number().int().nullable(),
  timezone: z.string().min(1).max(64),
});

export function parseGiveawayInput(body: unknown): GiveawayInput {
  const r = inputSchema.safeParse(body);
  if (!r.success) throw new AppError('bad_request', 'Некорректные данные: ' + r.error.issues.map((i) => i.path.join('.')).join(', '));
  return { ...r.data, countries: normalizeCountries(r.data.countries) };
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateGiveawayInput(ctx: AppContext, input: GiveawayInput, now: number) {
  const { cfg } = ctx;
  try {
    unitPriceCents(cfg, input.prizeType, input.prizeAmount);
  } catch (e) {
    if (e instanceof PricingError) throw new AppError('bad_request', e.message);
    throw e;
  }
  if (input.winnersCount > cfg.MAX_WINNERS) throw new AppError('bad_request', `Максимум победителей: ${cfg.MAX_WINNERS}`);
  if (!validTimezone(input.timezone)) throw new AppError('bad_request', 'Неизвестный часовой пояс');
  const start = input.startsAt && input.startsAt > now ? input.startsAt : now;
  if (input.endsAt - start < cfg.MIN_DURATION_MINUTES * 60_000)
    throw new AppError('bad_request', `Розыгрыш должен длиться не меньше ${cfg.MIN_DURATION_MINUTES} минут`);
  if (input.endsAt - start > cfg.MAX_DURATION_DAYS * 86_400_000) throw new AppError('bad_request', `Максимальная длительность — ${cfg.MAX_DURATION_DAYS} дней`);
  if (visibleLength(input.postText) > POST_TEXT_MAX) throw new AppError('bad_request', `Текст поста длиннее ${POST_TEXT_MAX} символов`);
}

function assertChannel(ctx: AppContext, userId: number, channelId: number | null) {
  if (channelId === null) return;
  const ch = ctx.repo.getChannel(channelId);
  if (!ch || !ch.active || !ctx.repo.isChannelManager(channelId, userId)) throw new AppError('forbidden', 'Канал не подключён к вашему аккаунту', 403);
}

function toRow(input: GiveawayInput) {
  return {
    channel_id: input.channelId,
    prize_type: input.prizeType,
    prize_amount: input.prizeAmount,
    winners_count: input.winnersCount,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    timezone: input.timezone,
    countries: input.countries ? JSON.stringify(input.countries) : null,
    captcha: input.captcha ? 1 : 0,
    honeypot: input.honeypot ? 1 : 0,
    require_subscription: input.requireSubscription ? 1 : 0,
    publish_results: input.publishResults ? 1 : 0,
    show_counter: input.showCounter ? 1 : 0,
    button_text: input.buttonText,
    post_text: input.postText,
  };
}

export function createGiveaway(ctx: AppContext, userId: number, input: GiveawayInput): GiveawayRow {
  const now = ctx.now();
  validateGiveawayInput(ctx, input, now);
  assertChannel(ctx, userId, input.channelId);
  const seed = randomSeed();
  const id = randomId(10);
  ctx.repo.insertGiveaway({
    id,
    creator_id: userId,
    status: 'draft',
    ...toRow(input),
    price_usd_cents: unitPriceCents(ctx.cfg, input.prizeType, input.prizeAmount) * input.winnersCount,
    cost_estimate_usd_cents: unitCostCents(ctx.cfg, input.prizeType, input.prizeAmount) * input.winnersCount,
    seed,
    seed_hash: sha256Hex(seed),
    created_at: now,
    updated_at: now,
  });
  return ctx.repo.getGiveaway(id)!;
}

export function getOwnGiveaway(ctx: AppContext, userId: number, gid: string): GiveawayRow {
  const g = ctx.repo.getGiveaway(gid);
  if (!g || g.creator_id !== userId) throw new AppError('not_found', 'Розыгрыш не найден', 404);
  return g;
}

/** Условия можно менять только до оплаты — после оплаты они зафиксированы (защита участников). */
export function updateDraft(ctx: AppContext, userId: number, gid: string, input: GiveawayInput): GiveawayRow {
  const g = getOwnGiveaway(ctx, userId, gid);
  if (g.status !== 'draft') throw new AppError('locked', 'После оплаты условия розыгрыша менять нельзя', 409);
  const inv = ctx.repo.latestInvoice(gid);
  if (inv && inv.paid_nano !== '0') throw new AppError('locked', 'По счёту уже есть оплата — условия зафиксированы', 409);
  const now = ctx.now();
  validateGiveawayInput(ctx, input, now);
  assertChannel(ctx, userId, input.channelId);
  ctx.repo.updateGiveaway(
    gid,
    {
      ...toRow(input),
      price_usd_cents: unitPriceCents(ctx.cfg, input.prizeType, input.prizeAmount) * input.winnersCount,
      cost_estimate_usd_cents: unitCostCents(ctx.cfg, input.prizeType, input.prizeAmount) * input.winnersCount,
    },
    now,
  );
  if (inv && inv.status === 'pending') ctx.repo.updateInvoice(inv.id, { status: 'expired' });
  return ctx.repo.getGiveaway(gid)!;
}

export function cancelDraft(ctx: AppContext, userId: number, gid: string) {
  const g = getOwnGiveaway(ctx, userId, gid);
  const inv = ctx.repo.latestInvoice(gid);
  if (g.status !== 'draft' || (inv && inv.paid_nano !== '0')) throw new AppError('locked', 'Оплаченный розыгрыш отменить нельзя', 409);
  ctx.repo.transitionGiveaway(gid, 'draft', 'cancelled', ctx.now());
}

export async function issueInvoice(ctx: AppContext, userId: number, gid: string): Promise<InvoiceView> {
  const g = getOwnGiveaway(ctx, userId, gid);
  if (g.status !== 'draft') throw new AppError('locked', 'Розыгрыш уже оплачен', 409);
  if (!ctx.receiveAddress) throw new AppError('internal', 'Приём оплаты не настроен', 503);
  if (g.channel_id === null) throw new AppError('channel_not_ready', 'Выберите канал для публикации');
  const ch = ctx.repo.getChannel(g.channel_id);
  if (!ch?.bot_can_post) throw new AppError('channel_not_ready', 'Бот не может публиковать в канале — дайте ему права администратора');
  const now = ctx.now();
  // дата окончания должна оставаться в будущем с запасом на оплату
  const start = g.starts_at && g.starts_at > now ? g.starts_at : now + ctx.cfg.INVOICE_TTL_MIN * 60_000;
  if (g.ends_at - start < ctx.cfg.MIN_DURATION_MINUTES * 60_000) throw new AppError('bad_request', 'Дата окончания слишком близко — передвиньте её');

  const existing = ctx.repo.latestInvoice(gid);
  if (existing && existing.status === 'pending' && existing.expires_at - now > 3 * 60_000) return invoiceView(ctx, existing);
  if (existing && existing.status === 'underpaid') return invoiceView(ctx, existing);
  if (existing && existing.status === 'pending') ctx.repo.updateInvoice(existing.id, { status: 'expired' });

  const rate = await ctx.rates.tonUsd();
  const q = quote(ctx.cfg, g.prize_type, g.prize_amount, g.winners_count, rate);
  const id = randomId(12);
  const comment = `SL-${randomId(8, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789')}`;
  ctx.repo.insertInvoice({
    id,
    giveaway_id: gid,
    comment,
    amount_nano: q.totalNano,
    amount_usd_cents: q.totalCents,
    ton_usd_rate: rate,
    status: 'pending',
    created_at: now,
    expires_at: now + ctx.cfg.INVOICE_TTL_MIN * 60_000,
  });
  return invoiceView(ctx, ctx.repo.getInvoice(id)!);
}

export function invoiceView(ctx: AppContext, inv: InvoiceRow): InvoiceView {
  const address = ctx.receiveAddress ?? '';
  const due = BigInt(inv.amount_nano) - BigInt(inv.paid_nano);
  const toPay = due > 0n ? due : 0n;
  return {
    id: inv.id,
    address,
    amountNano: inv.amount_nano,
    amountTon: formatTon(inv.amount_nano),
    paidNano: inv.paid_nano,
    comment: inv.comment,
    payload: commentPayload(inv.comment),
    tonLink: tonTransferLink(address, toPay.toString(), inv.comment),
    expiresAt: inv.expires_at,
    status: inv.status,
  };
}

function winnersView(ctx: AppContext, gid: string): WinnerView[] {
  return ctx.repo.listWinners(gid).map((w) => ({
    place: w.place,
    name: w.first_name || 'Участник',
    username: w.username,
    prizeStatus: w.status,
  }));
}

export function ownerView(ctx: AppContext, g: GiveawayRow): GiveawayOwnerView {
  const ch = g.channel_id !== null ? ctx.repo.getChannel(g.channel_id) : undefined;
  const inv = ctx.repo.latestInvoice(g.id);
  return {
    id: g.id,
    status: g.status,
    prizeType: g.prize_type,
    prizeAmount: g.prize_amount,
    winnersCount: g.winners_count,
    startsAt: g.starts_at,
    endsAt: g.ends_at,
    countries: countryList(g.countries),
    captcha: !!g.captcha,
    honeypot: !!g.honeypot,
    requireSubscription: !!g.require_subscription,
    publishResults: !!g.publish_results,
    showCounter: !!g.show_counter,
    buttonText: g.button_text,
    postText: g.post_text,
    channelId: g.channel_id,
    timezone: g.timezone,
    participantsCount: g.participants_count,
    priceUsd: g.price_usd_cents / 100,
    channel: ch ? { id: ch.id, title: ch.title, username: ch.username, botCanPost: !!ch.bot_can_post } : null,
    invoice: inv && g.status === 'draft' ? invoiceView(ctx, inv) : null,
    postUrl: ch && g.post_message_id ? ctx.links.channelPost(ch, g.post_message_id) : null,
    appLink: ctx.links.giveaway(g.id),
    seedHash: g.seed_hash,
    lastError: g.last_error,
    createdAt: g.created_at,
    paidAt: g.paid_at,
    publishedAt: g.published_at,
    drawnAt: g.drawn_at,
    winners: g.status === 'finished' ? winnersView(ctx, g.id) : [],
  };
}

export function phaseOf(g: GiveawayRow, now: number): Phase {
  switch (g.status) {
    case 'draft':
      return 'unpaid';
    case 'paid':
    case 'scheduled':
      return 'upcoming';
    case 'active':
      return now < g.ends_at ? 'active' : 'drawing';
    case 'drawing':
      return 'drawing';
    case 'finished':
      return 'finished';
    default:
      return 'cancelled';
  }
}

export function ticketsFor(ctx: AppContext, gid: string, uid: number): { tickets: number; referrals: number } {
  const referrals = ctx.repo.countActiveReferrals(gid, uid);
  return { tickets: 1 + Math.min(referrals, ctx.cfg.REF_TICKET_CAP), referrals };
}

export function publicView(ctx: AppContext, g: GiveawayRow, user: UserRow): PublicGiveawayView {
  const now = ctx.now();
  const ch = g.channel_id !== null ? ctx.repo.getChannel(g.channel_id) : undefined;
  const p = ctx.repo.getParticipant(g.id, user.id);
  // забаненный видит себя «не участвующим»; причину узнает только при нажатии кнопки участия
  const joined = !!p && p.status === 'active';
  const t = joined ? ticketsFor(ctx, g.id, user.id) : { tickets: 0, referrals: 0 };
  const countries = countryList(g.countries);
  const phoneCountry = user.phone_country && user.phone_country !== 'XX' ? user.phone_country : null;
  const finished = g.status === 'finished';
  return {
    id: g.id,
    phase: phaseOf(g, now),
    prizeType: g.prize_type,
    prizeAmount: g.prize_amount,
    winnersCount: g.winners_count,
    startsAt: g.starts_at ?? g.published_at,
    endsAt: g.ends_at,
    countries,
    captcha: !!g.captcha,
    requireSubscription: !!g.require_subscription,
    channel: { title: ch?.title ?? 'Канал', username: ch?.username ?? null, url: ch ? ctx.links.channel(ch) : null },
    participantsCount: g.participants_count,
    seedHash: g.seed_hash,
    me: {
      joined,
      tickets: t.tickets,
      referrals: t.referrals,
      refLink: joined ? ctx.links.giveaway(g.id, p!.ref_code) : null,
      hasUsername: !!user.username,
      phoneCountry,
      countryOk: isCountryAllowed(countries, phoneCountry),
      isWinner: finished && !!ctx.repo.getWinner(g.id, user.id),
    },
    results: finished ? { drawnAt: g.drawn_at ?? g.ends_at, winners: winnersView(ctx, g.id), proofAvailable: !!g.proof } : null,
  };
}

export function getPublicGiveaway(ctx: AppContext, gid: string): GiveawayRow {
  const g = ctx.repo.getGiveaway(gid);
  if (!g || g.status === 'draft' || g.status === 'cancelled') throw new AppError('not_found', 'Розыгрыш не найден', 404);
  return g;
}

export async function isSubscribed(ctx: AppContext, channelId: number, userId: number): Promise<boolean> {
  try {
    const m = await ctx.tg.getChatMember(channelId, userId);
    if (m.status === 'creator' || m.status === 'administrator' || m.status === 'member') return true;
    if (m.status === 'restricted') return !!(m as { is_member?: boolean }).is_member;
    return false;
  } catch (e) {
    if (e instanceof GrammyError && e.error_code === 400) return false;
    throw e;
  }
}

export const BANNED_MESSAGE =
  'Доступ к розыгрышу заблокирован: система защиты зафиксировала автоматические действия с вашего аккаунта. Если это ошибка — напишите организатору.';

export async function honeypotHit(ctx: AppContext, g: GiveawayRow, userId: number, kind: string) {
  if (!g.honeypot) return;
  const now = ctx.now();
  const added = ctx.repo.addBan(g.id, userId, `honeypot:${kind}`, now);
  if (!added) return;
  const hits = ctx.repo.incHoneypotHits(userId);
  if (hits >= ctx.cfg.HONEYPOT_GLOBAL_BAN_HITS) ctx.repo.addBan('*', userId, 'honeypot:repeat', now);
  const p = ctx.repo.getParticipant(g.id, userId);
  if (p && p.status === 'active') {
    ctx.repo.setParticipantStatus(g.id, userId, 'banned');
    ctx.repo.recountParticipants(g.id);
  }
  ctx.log.warn({ gid: g.id, userId, kind, hits }, 'honeypot triggered');
}

export async function createChallenge(ctx: AppContext, g: GiveawayRow, user: UserRow) {
  const now = ctx.now();
  if (phaseOf(g, now) !== 'active') throw new AppError('not_active', 'Розыгрыш сейчас не принимает участников');
  if (!g.captcha) throw new AppError('bad_request', 'Капча в этом розыгрыше не требуется');
  if (ctx.repo.countRecentCaptchas(user.id, now - 10 * 60_000) >= 15) throw new AppError('rate_limited', 'Слишком много попыток. Подождите 10 минут.', 429);
  const c = await ctx.captcha.create(g.id, user.id, now);
  return { challengeId: c.challengeId, image: c.image, expiresAt: c.expiresAt };
}

export type JoinOutcome = { kind: 'joined' | 'already'; view: PublicGiveawayView } | { kind: 'decoy' };

export async function join(
  ctx: AppContext,
  g: GiveawayRow,
  user: UserRow,
  req: JoinRequest,
  meta: { ipCountry?: string | null; startParam?: string | null } = {},
): Promise<JoinOutcome> {
  const now = ctx.now();
  if (phaseOf(g, now) !== 'active') throw new AppError('not_active', 'Розыгрыш сейчас не принимает участников');

  // Скрытое поле: человек его не видит. Боту отвечаем «успехом», но доступ закрываем.
  if (g.honeypot && req.website && req.website.trim() !== '') {
    await honeypotHit(ctx, g, user.id, 'hidden_field');
    return { kind: 'decoy' };
  }
  if (user.global_ban || ctx.repo.getBan(g.id, user.id)) throw new AppError('banned', BANNED_MESSAGE, 403);
  if (g.creator_id === user.id) throw new AppError('forbidden', 'Организатор не может участвовать в своём розыгрыше', 403);

  const existing = ctx.repo.getParticipant(g.id, user.id);
  if (existing) {
    if (existing.status !== 'active') throw new AppError('banned', BANNED_MESSAGE, 403);
    return { kind: 'already', view: publicView(ctx, g, user) };
  }

  if (!user.username) throw new AppError('need_username', 'Чтобы получить приз, нужен публичный @username. Установите его в настройках Telegram и откройте розыгрыш снова.');

  const countries = countryList(g.countries);
  if (countries) {
    if (!user.phone_country) throw new AppError('need_phone', 'Розыгрыш доступен только для некоторых стран — подтвердите номер телефона');
    if (!isCountryAllowed(countries, user.phone_country)) throw new AppError('country_not_allowed', 'Розыгрыш недоступен для вашей страны');
    if (ctx.cfg.GEO_IP_MODE === 'enforce' && meta.ipCountry && !isCountryAllowed(countries, meta.ipCountry))
      throw new AppError('country_not_allowed', 'Розыгрыш недоступен для вашего региона');
  }

  if (g.require_subscription && g.channel_id !== null) {
    if (!(await isSubscribed(ctx, g.channel_id, user.id))) throw new AppError('need_subscription', 'Подпишитесь на канал, чтобы участвовать');
  }

  let solveMs: number | undefined;
  if (g.captcha) {
    const v = ctx.captcha.verify(req.challengeId, g.id, user.id, req.answer, now);
    solveMs = v.solveMs;
    if (v.verdict === 'missing') throw new AppError('captcha_required', 'Введите символы с картинки');
    if (v.verdict === 'expired') throw new AppError('captcha_expired', 'Картинка устарела — вот новая');
    if (v.verdict === 'too_fast') throw new AppError('too_fast', 'Слишком быстро. Попробуйте ещё раз');
    if (v.verdict === 'wrong') throw new AppError('captcha_wrong', 'Неверно. Попробуйте ещё раз');
  }

  let risk = 0;
  if (req.signals?.webdriver) risk += 50;
  if (g.captcha && (req.signals?.interactions ?? 0) === 0) risk += 10;
  if (solveMs !== undefined && solveMs < 3000) risk += 10;

  const refCode = req.ref ?? parseStartParam(meta.startParam)?.ref ?? null;
  let referrerId: number | null = null;
  if (refCode) {
    const rp = ctx.repo.getParticipantByRef(g.id, refCode);
    if (rp && rp.user_id !== user.id && rp.status === 'active') referrerId = rp.user_id;
  }

  const inserted = ctx.repo.tx(() => {
    for (let i = 0; i < 5; i++) {
      try {
        const ok = ctx.repo.insertParticipant({
          giveaway_id: g.id,
          user_id: user.id,
          ref_code: randomId(6),
          referrer_id: referrerId,
          country: user.phone_country,
          ip_country: meta.ipCountry ?? null,
          risk,
          solve_ms: solveMs ?? null,
          joined_at: now,
        });
        if (ok) ctx.repo.incParticipants(g.id);
        return ok;
      } catch (e) {
        if (String(e).includes('ref_code')) continue; // коллизия реф-кода
        throw e;
      }
    }
    throw new Error('не удалось сгенерировать ref_code');
  });
  const fresh = ctx.repo.getGiveaway(g.id)!;
  return { kind: inserted ? 'joined' : 'already', view: publicView(ctx, fresh, user) };
}

/** Номер телефона → страна. Сам номер не храним. */
export function applyContact(ctx: AppContext, userId: number, contact: { user_id?: number; phone_number: string }): string | null {
  if (contact.user_id !== userId) return null;
  const country = countryFromPhone(contact.phone_number) ?? 'XX';
  ctx.repo.setPhoneCountry(userId, country, ctx.now());
  return country;
}
