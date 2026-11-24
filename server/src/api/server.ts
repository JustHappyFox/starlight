import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join as joinPath } from 'node:path';
import sharp from 'sharp';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/repo.js';
import type { AppConfigView, JoinRequest, MeView } from '../../../shared/types.js';
import { BUTTON_PRESETS, BUTTON_TEXT_MAX, POST_TEXT_MAX, PREMIUM_MONTHS, STARS_PRESETS } from '../config.js';
import { InitDataError, signInitData, validateInitData, verifySignedQuery, type ValidatedInitData } from '../tg/initData.js';
import {
  AppError,
  applyContact,
  checkRecipient,
  claimPrize,
  cancelDraft,
  createChallenge,
  createGiveaway,
  getOwnGiveaway,
  getPublicGiveaway,
  honeypotHit,
  issueInvoice,
  join,
  ownerView,
  parseGiveawayInput,
  publicView,
  updateDraft,
} from '../services/giveaways.js';
import { quote } from '../services/pricing.js';
import { renderPost } from '../services/post.js';
import { schedulePublish } from '../services/scheduler.js';
import { isAdmin } from '../services/notify.js';
import { RateLimiter } from '../util/rateLimit.js';
import { handleTx } from '../ton/payments.js';
import { linkChannelByUsername } from '../bot/channels.js';

declare module 'fastify' {
  interface FastifyRequest {
    tg?: ValidatedInitData;
    user?: UserRow;
  }
}

export interface ApiOptions {
  webhook?: { path: string; handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
  logger?: boolean;
}

const PUBLIC_PATHS = new Set(['/api/health', '/api/config']);

export async function buildServer(ctx: AppContext, opts: ApiOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 64 * 1024 });
  const { cfg, repo } = ctx;

  if (cfg.WEBAPP_ORIGIN) await app.register(fastifyCors, { origin: cfg.WEBAPP_ORIGIN.split(',').map((s) => s.trim()) });

  const joinLimiter = new RateLimiter(20, 60_000);
  const readLimiter = new RateLimiter(120, 60_000);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof InitDataError) return reply.status(401).send({ error: { code: 'unauthorized', message: err.message } });
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation || e.statusCode === 400) return reply.status(400).send({ error: { code: 'bad_request', message: e.message ?? 'bad request' } });
    ctx.log.error({ err: String((err as Error)?.stack ?? err), url: req.url }, 'api error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Внутренняя ошибка, попробуйте позже' } });
  });

  // ---------- аутентификация через initData ----------
  app.addHook('preHandler', async (req) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/') || PUBLIC_PATHS.has(path) || path.startsWith('/api/dev/')) return;
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('tma ')) throw new AppError('unauthorized', 'Откройте приложение из Telegram', 401);
    const tg = validateInitData(h.slice(4), cfg.BOT_TOKEN, cfg.INIT_DATA_MAX_AGE_SEC, ctx.now());
    if (!readLimiter.allow(`u:${tg.user.id}`)) throw new AppError('rate_limited', 'Слишком много запросов', 429);
    repo.upsertUser(
      {
        id: tg.user.id,
        username: tg.user.username ?? null,
        first_name: tg.user.first_name,
        last_name: tg.user.last_name ?? null,
        language_code: tg.user.language_code ?? null,
        is_premium: !!tg.user.is_premium,
        allows_pm: !!tg.user.allows_write_to_pm,
      },
      ctx.now(),
    );
    req.tg = tg;
    req.user = repo.getUser(tg.user.id)!;
  });

  const user = (req: FastifyRequest) => req.user!;
  const ipCountry = (req: FastifyRequest) => {
    if (cfg.GEO_IP_MODE === 'off') return null;
    const c = req.headers['cf-ipcountry'];
    return typeof c === 'string' && /^[A-Z]{2}$/.test(c) ? c : null;
  };

  // ---------- общие ----------
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/config', async (): Promise<AppConfigView> => ({
    botUsername: ctx.links.botUsername,
    appLink: ctx.links.app(),
    limits: {
      minStars: cfg.MIN_STARS,
      maxStars: cfg.MAX_STARS,
      starsPresets: STARS_PRESETS.filter((s) => s >= cfg.MIN_STARS),
      premiumMonths: [...PREMIUM_MONTHS],
      maxWinners: cfg.MAX_WINNERS,
      maxDurationDays: cfg.MAX_DURATION_DAYS,
      minDurationMinutes: cfg.MIN_DURATION_MINUTES,
      buttonTextMax: BUTTON_TEXT_MAX,
      postTextMax: POST_TEXT_MAX,
    },
    buttonPresets: BUTTON_PRESETS,
    refTicketCap: cfg.REF_TICKET_CAP,
    tonConnectManifestUrl: `${cfg.PUBLIC_URL.replace(/\/$/, '')}/tonconnect-manifest.json`,
    devMode: cfg.DEV_MODE,
  }));

  app.get('/api/me', async (req): Promise<MeView> => {
    const u = user(req);
    return {
      id: u.id,
      firstName: u.first_name,
      username: u.username,
      phoneCountry: u.phone_country && u.phone_country !== 'XX' ? u.phone_country : null,
      isAdmin: isAdmin(ctx, u.id),
      channels: repo.listUserChannels(u.id).map((c) => ({ id: c.id, title: c.title, username: c.username, botCanPost: !!c.bot_can_post && !!c.bot_can_edit })),
      connectChannelLink: ctx.links.connectChannel(),
      botUsername: ctx.links.botUsername,
    };
  });

  app.post<{ Body: { response?: string } }>('/api/me/contact', async (req) => {
    const u = user(req);
    const raw = req.body?.response;
    if (!raw) throw new AppError('bad_request', 'Нет данных контакта');
    const fields = verifySignedQuery(raw, cfg.BOT_TOKEN);
    if (Number(fields.auth_date) * 1000 < ctx.now() - 3_600_000) throw new AppError('bad_request', 'Данные контакта устарели');
    const contact = JSON.parse(fields.contact ?? '{}') as { user_id?: number; phone_number?: string };
    if (!contact.phone_number) throw new AppError('bad_request', 'Нет номера');
    const country = applyContact(ctx, u.id, { user_id: contact.user_id, phone_number: contact.phone_number });
    if (!country) throw new AppError('forbidden', 'Это не ваш контакт', 403);
    return { phoneCountry: country === 'XX' ? null : country };
  });

  app.post<{ Body: { username?: string } }>('/api/channels/link', async (req) => {
    const ch = await linkChannelByUsername(ctx, user(req).id, String(req.body?.username ?? ''));
    return { id: ch.id, title: ch.title, username: ch.username, botCanPost: !!ch.bot_can_post && !!ch.bot_can_edit };
  });

  app.get<{ Querystring: { type?: string; amount?: string; winners?: string } }>('/api/quote', async (req) => {
    const type = req.query.type === 'premium' ? 'premium' : 'stars';
    const amount = Number(req.query.amount);
    const winners = Number(req.query.winners);
    if (!Number.isInteger(winners) || winners < 1 || winners > cfg.MAX_WINNERS) throw new AppError('bad_request', 'Некорректное число победителей');
    const rate = await ctx.rates.tonUsd();
    try {
      const { totalCents: _t, costCents: _c, ...q } = quote(cfg, type, amount, winners, rate);
      return q;
    } catch (e) {
      throw new AppError('bad_request', (e as Error).message);
    }
  });

  // ---------- организатор ----------
  app.get('/api/giveaways', async (req) => repo.listCreatorGiveaways(user(req).id).map((g) => ownerView(ctx, g)));

  app.post('/api/giveaways', async (req) => ownerView(ctx, createGiveaway(ctx, user(req).id, parseGiveawayInput(req.body))));

  app.get<{ Params: { id: string } }>('/api/giveaways/:id', async (req) => ownerView(ctx, getOwnGiveaway(ctx, user(req).id, req.params.id)));

  app.put<{ Params: { id: string } }>('/api/giveaways/:id', async (req) =>
    ownerView(ctx, updateDraft(ctx, user(req).id, req.params.id, parseGiveawayInput(req.body))),
  );

  app.delete<{ Params: { id: string } }>('/api/giveaways/:id', async (req) => {
    cancelDraft(ctx, user(req).id, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/giveaways/:id/invoice', async (req) => issueInvoice(ctx, user(req).id, req.params.id));

  // Публикация после оплаты: { at: null } — сейчас, { at: <ms UTC> } — по расписанию
  app.post<{ Params: { id: string }; Body: { at?: number | null } }>('/api/giveaways/:id/publish', async (req) => {
    const at = req.body?.at;
    if (at !== undefined && at !== null && typeof at !== 'number') throw new AppError('bad_request', 'Некорректное время');
    return ownerView(ctx, await schedulePublish(ctx, user(req).id, req.params.id, at ?? null));
  });

  app.post<{ Params: { id: string } }>('/api/giveaways/:id/preview', async (req) => {
    const g = getOwnGiveaway(ctx, user(req).id, req.params.id);
    try {
      await ctx.tg.sendMessage(user(req).id, renderPost(g), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [[{ text: g.button_text, url: ctx.links.giveaway(g.id) }]] },
      });
    } catch (e) {
      throw new AppError('bad_request', `Не удалось отправить предпросмотр: ${(e as Error).message}. Запустите бота (/start).`);
    }
    return { ok: true };
  });

  // ---------- участник ----------
  app.get<{ Params: { id: string } }>('/api/g/:id', async (req) => publicView(ctx, getPublicGiveaway(ctx, req.params.id), user(req)));

  app.post<{ Params: { id: string } }>('/api/g/:id/challenge', async (req) => {
    if (!joinLimiter.allow(`c:${user(req).id}`)) throw new AppError('rate_limited', 'Слишком много попыток, подождите минуту', 429);
    return createChallenge(ctx, getPublicGiveaway(ctx, req.params.id), user(req));
  });

  app.post<{ Params: { id: string }; Body: JoinRequest }>('/api/g/:id/join', async (req) => {
    if (!joinLimiter.allow(`j:${user(req).id}`)) throw new AppError('rate_limited', 'Слишком много попыток, подождите минуту', 429);
    const g = getPublicGiveaway(ctx, req.params.id);
    const body = (req.body ?? {}) as JoinRequest;
    const r = await join(
      ctx,
      g,
      user(req),
      {
        challengeId: typeof body.challengeId === 'string' ? body.challengeId : undefined,
        answer: typeof body.answer === 'string' ? body.answer.slice(0, 16) : undefined,
        ref: typeof body.ref === 'string' && /^[A-Za-z0-9]{4,16}$/.test(body.ref) ? body.ref : undefined,
        website: typeof body.website === 'string' ? body.website : undefined,
        signals: typeof body.signals === 'object' && body.signals ? body.signals : undefined,
      },
      { ipCountry: ipCountry(req), startParam: req.tg?.startParam },
    );
    if (r.kind === 'decoy') return { ok: true };
    return r.view;
  });

  // Победитель без ника / с активным Premium: выбрать, на какой аккаунт отправить приз
  app.post<{ Params: { id: string }; Body: { username?: string } }>('/api/g/:id/claim/check', async (req) => {
    if (!joinLimiter.allow(`cc:${user(req).id}`)) throw new AppError('rate_limited', 'Слишком много проверок, подождите минуту', 429);
    return checkRecipient(ctx, getPublicGiveaway(ctx, req.params.id), user(req), String(req.body?.username ?? ''));
  });
  app.post<{ Params: { id: string }; Body: { username?: string | null } }>('/api/g/:id/claim', async (req) => {
    if (!joinLimiter.allow(`cl:${user(req).id}`)) throw new AppError('rate_limited', 'Слишком много попыток, подождите минуту', 429);
    const raw = req.body?.username;
    return claimPrize(ctx, getPublicGiveaway(ctx, req.params.id), user(req), typeof raw === 'string' && raw.trim() ? raw : null);
  });

  // Ловушки. Невидимая кнопка в интерфейсе шлёт сюда; «очевидный» эндпоинт /participate
  // нигде не используется настоящим клиентом — его дёргают только скрипты.
  const trap = async (req: FastifyRequest<{ Params: { id: string } }>, kind: string) => {
    const g = repo.getGiveaway(req.params.id);
    if (g) await honeypotHit(ctx, g, user(req).id, kind);
    return { ok: true };
  };
  app.post<{ Params: { id: string }; Body: { kind?: string } }>('/api/g/:id/hp', async (req) =>
    trap(req, typeof req.body?.kind === 'string' ? req.body.kind.slice(0, 24).replace(/[^a-z_]/g, '') || 'button' : 'button'),
  );
  app.post<{ Params: { id: string } }>('/api/g/:id/participate', async (req) => trap(req, 'decoy_endpoint'));

  app.get<{ Params: { id: string } }>('/api/g/:id/proof', async (req, reply) => {
    const g = getPublicGiveaway(ctx, req.params.id);
    if (g.status !== 'finished' || !g.proof) throw new AppError('not_found', 'Итоги ещё не подведены', 404);
    reply.header('content-disposition', `attachment; filename="proof-${g.id}.json"`);
    return JSON.parse(g.proof);
  });

  // ---------- dev-режим ----------
  if (cfg.DEV_MODE) {
    app.get<{ Querystring: { id?: string; username?: string; name?: string; start?: string } }>('/api/dev/initdata', async (req) => {
      const fields: Record<string, string> = {
        auth_date: String(Math.floor(ctx.now() / 1000)),
        query_id: 'dev',
        user: JSON.stringify({
          id: Number(req.query.id ?? 1001),
          first_name: req.query.name ?? 'Dev',
          username: req.query.username === '' ? undefined : (req.query.username ?? 'dev_user'),
          language_code: 'ru',
          allows_write_to_pm: true,
        }),
      };
      if (req.query.start) fields.start_param = req.query.start;
      return { initData: signInitData(fields, cfg.BOT_TOKEN) };
    });
    app.post<{ Params: { invoice: string } }>('/api/dev/pay/:invoice', async (req) => {
      const inv = repo.getInvoice(req.params.invoice);
      if (!inv) throw new AppError('not_found', 'нет счёта', 404);
      await handleTx(ctx, {
        hash: `dev-${inv.id}-${ctx.now()}`,
        lt: String(ctx.now()),
        utime: Math.floor(ctx.now() / 1000),
        source: 'dev',
        value: BigInt(inv.amount_nano) - BigInt(inv.paid_nano),
        comment: inv.comment,
        aborted: false,
        bounced: false,
      });
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>('/api/dev/finish/:id', async (req) => {
      repo.updateGiveaway(req.params.id, { ends_at: ctx.now() - 1 }, ctx.now());
      return { ok: true };
    });
  }

  // ---------- TON Connect manifest ----------
  const base = cfg.PUBLIC_URL.replace(/\/$/, '');
  // iconUrl — от адреса, на который пришёл запрос (бэкенд может жить отдельно от фронта)
  app.get('/tonconnect-manifest.json', async (req) => ({ url: base, name: 'Starlight Giveaways', iconUrl: `${req.protocol}://${req.host}/icon.png` }));
  let iconCache: Buffer | null = null;
  app.get('/icon.png', async (_req, reply) => {
    if (!iconCache) {
      const svgPath = [resolve(cfg.WEBAPP_DIST, 'favicon.svg'), resolve(cfg.WEBAPP_DIST, '../public/favicon.svg')].find((p) => existsSync(p));
      const svg = svgPath ? readFileSync(svgPath) : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#7c5cff"/></svg>');
      iconCache = await sharp(svg, { density: 300 }).resize(180, 180).png().toBuffer();
    }
    return reply.type('image/png').send(iconCache);
  });

  if (opts.webhook) app.post(opts.webhook.path, opts.webhook.handler);

  // ---------- статика мини-аппа ----------
  const dist = resolve(cfg.WEBAPP_DIST);
  if (existsSync(joinPath(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', index: ['index.html'], maxAge: '1h' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'not_found', message: 'not found' } });
      return reply.type('text/html').header('cache-control', 'no-cache').sendFile('index.html');
    });
  }

  return app;
}
