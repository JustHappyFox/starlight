import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { onBotMembership } from '../src/bot/channels.js';
import { publishGiveaway, startScheduler } from '../src/services/scheduler.js';
import { handleTx } from '../src/ton/payments.js';
import { pseudonym, runDraw, verifyProof } from '../../shared/fairness.js';
import { DeliveryError } from '../src/fulfillment/provider.js';
import type { DrawProof, GiveawayOwnerView, InvoiceView, PublicGiveawayView } from '../../shared/types.js';
import { baseInput, CHANNEL_ID, makeEnv, type TestEnv } from './helpers.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const CREATOR = { id: 10, username: 'creator', first_name: 'Org' };

async function setup(envOver: Record<string, string> = {}) {
  const env = makeEnv(envOver);
  const app = await buildServer(env.ctx);
  vi.spyOn(env.ctx.captcha, 'render').mockResolvedValue({ text: 'ACDEFG', png: Buffer.from('png') });
  env.tg.members.set(CREATOR.id, 'creator');
  await onBotMembership(env.ctx, { id: CHANNEL_ID, type: 'channel', title: 'Test Channel', username: 'testchan' }, CREATOR.id, {
    status: 'administrator',
    can_post_messages: true,
    can_edit_messages: true,
  });
  return { env, app };
}

function api(app: FastifyInstance, env: TestEnv, user: { id: number; username?: string; first_name?: string }, startParam?: string) {
  const auth = { authorization: `tma ${env.initData(user, startParam)}` };
  return {
    get: (url: string) => app.inject({ method: 'GET', url, headers: auth }),
    post: (url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers: auth, payload: (payload ?? {}) as object }),
    put: (url: string, payload: unknown) => app.inject({ method: 'PUT', url, headers: auth, payload: payload as object }),
  };
}

/** Создать и оплатить: розыгрыш ждёт нажатия «Опубликовать» (статус paid) */
async function createPaid(env: TestEnv, app: FastifyInstance, input: Record<string, unknown> = {}) {
  const org = api(app, env, CREATOR);
  const created = await org.post('/api/giveaways', baseInput(input));
  expect(created.statusCode, created.body).toBe(200);
  const g = created.json() as GiveawayOwnerView;
  const inv = (await org.post(`/api/giveaways/${g.id}/invoice`)).json() as InvoiceView;
  await handleTx(env.ctx, {
    hash: 'tx1',
    lt: '1',
    utime: env.clock.t / 1000,
    source: 'UQsrc',
    value: BigInt(inv.amountNano),
    comment: inv.comment,
    aborted: false,
    bounced: false,
  });
  const sched = startScheduler(env.ctx, { autoStart: false });
  await sched.tick();
  return { g: (await org.get(`/api/giveaways/${g.id}`)).json() as GiveawayOwnerView, sched, org };
}

/** Создать, оплатить и нажать «Опубликовать сейчас» */
async function createPaidActive(env: TestEnv, app: FastifyInstance, input: Record<string, unknown> = {}) {
  const { g, sched, org } = await createPaid(env, app, input);
  const pub = await org.post(`/api/giveaways/${g.id}/publish`, { at: null });
  expect(pub.statusCode, pub.body).toBe(200);
  return { g: pub.json() as GiveawayOwnerView, sched, org };
}

async function joinWithCaptcha(app: FastifyInstance, env: TestEnv, user: { id: number; username?: string }, gid: string, extra: Record<string, unknown> = {}, startParam?: string) {
  const u = api(app, env, user, startParam);
  const ch = await u.post(`/api/g/${gid}/challenge`);
  expect(ch.statusCode, ch.body).toBe(200);
  env.clock.advance(2500);
  return u.post(`/api/g/${gid}/join`, { challengeId: ch.json().challengeId, answer: 'acdefg', signals: { interactions: 5 }, ...extra });
}

describe('полный сценарий', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it('создание → оплата → публикация → участие → рефералы → ловушка → итоги → выдача', async () => {
    const { env, app } = s;
    const me = (await api(app, env, CREATOR).get('/api/me')).json();
    expect(me.channels).toHaveLength(1);

    const { g, sched } = await createPaidActive(env, app);
    expect(g.status).toBe('active');
    const post = env.tg.channelPosts()[0]!;
    expect(post.text).toContain('Большой розыгрыш');
    expect(post.text).toContain('Хеш честности');
    const btn = (post.opts!.reply_markup as { inline_keyboard: { text: string; url: string }[][] }).inline_keyboard[0]![0]!;
    expect(btn.url).toBe(`https://t.me/test_bot?startapp=${g.id}`);

    // участник 1
    const r1 = await joinWithCaptcha(app, env, { id: 101, username: 'u101' }, g.id);
    expect(r1.statusCode, r1.body).toBe(200);
    const v1 = r1.json() as PublicGiveawayView;
    expect(v1.me.joined).toBe(true);
    expect(v1.me.tickets).toBe(1);
    const ref = new URL(v1.me.refLink!).searchParams.get('startapp')!.split('_')[1]!;

    // двое приглашённых по реф-ссылке (через start_param)
    for (const id of [102, 103]) {
      const r = await joinWithCaptcha(app, env, { id, username: `u${id}` }, g.id, {}, `${g.id}_${ref}`);
      expect(r.statusCode, r.body).toBe(200);
    }
    const again = (await api(app, env, { id: 101, username: 'u101' }).get(`/api/g/${g.id}`)).json() as PublicGiveawayView;
    expect(again.me.referrals).toBe(2);
    expect(again.me.tickets).toBe(3);
    expect(again.participantsCount).toBe(3);

    // повторное участие идемпотентно
    const dup = await api(app, env, { id: 101, username: 'u101' }).post(`/api/g/${g.id}/join`, {});
    expect(dup.statusCode).toBe(200);
    expect((dup.json() as PublicGiveawayView).participantsCount).toBe(3);

    // бот жмёт невидимую кнопку → получает «успех», а при нажатии настоящей — блокировку
    const bot = api(app, env, { id: 666, username: 'botty' });
    expect((await bot.post(`/api/g/${g.id}/hp`, { kind: 'button' })).json()).toEqual({ ok: true });
    // капча всё ещё выдаётся (не палим ловушку), но участие — заблокировано с понятным сообщением
    const blocked = await joinWithCaptcha(app, env, { id: 666, username: 'botty' }, g.id);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toMatch(/заблокирован/);
    const blockedJoin = await bot.post(`/api/g/${g.id}/join`, {});
    expect(blockedJoin.statusCode).toBe(403);
    expect(blockedJoin.json().error.code).toBe('banned');

    // скрытое поле формы
    const filler = await api(app, env, { id: 667, username: 'filler' }).post(`/api/g/${g.id}/join`, { website: 'http://spam' });
    expect(filler.json()).toEqual({ ok: true });
    expect((await api(app, env, { id: 667, username: 'filler' }).post(`/api/g/${g.id}/join`, {})).json().error.code).toBe('banned');

    // счётчик на кнопке обновляется не чаще интервала
    env.clock.advance(61_000);
    await sched.tick();
    const edit = env.tg.edits.at(-1)!;
    expect(JSON.stringify(edit.markup)).toContain('Участвовать (3)');

    // окончание: подписка 103 пропала → дисквалификация при проверке
    env.tg.members.set(103, 'left');
    env.clock.advance(3 * 86_400_000);
    await sched.tick();
    const owner = (await api(app, env, CREATOR).get(`/api/giveaways/${g.id}`)).json() as GiveawayOwnerView;
    expect(owner.status).toBe('finished');
    expect(owner.winners).toHaveLength(2);
    expect(owner.winners.map((w) => w.username)).not.toContain('u103');

    // итоги опубликованы в канале, кнопка → «Результаты»
    expect(env.tg.channelPosts().some((p) => p.text.includes('Итоги розыгрыша'))).toBe(true);
    expect(JSON.stringify(env.tg.edits.at(-1)!.markup)).toContain('Результаты');

    // призы выданы (mock-провайдер) на актуальные username
    await sched.tick();
    expect(env.provider.delivered.map((d) => d.username).sort()).toEqual(['u101', 'u102']);
    const pub = (await api(app, env, { id: 101, username: 'u101' }).get(`/api/g/${g.id}`)).json() as PublicGiveawayView;
    expect(pub.phase).toBe('finished');
    expect(pub.results!.winners.every((w) => w.prizeStatus === 'sent')).toBe(true);

    // доказательство честности проверяется независимо
    const proof = (await api(app, env, { id: 101 }).get(`/api/g/${g.id}/proof`)).json() as DrawProof;
    expect(proof.entries).toHaveLength(3);
    expect(proof.entropy.source).toBe('ton-masterchain:42');
    expect((await verifyProof(sha, proof)).ok).toBe(true);
    expect(JSON.stringify(proof)).not.toContain('"101"');
  });

  it('условия после оплаты заблокированы', async () => {
    const { env, app } = s;
    const { g, org } = await createPaidActive(env, app);
    const r = await org.put(`/api/giveaways/${g.id}`, baseInput({ winnersCount: 1 }));
    expect(r.statusCode).toBe(409);
  });

  it('капча: неверный ответ, слишком быстро, одноразовость', async () => {
    const { env, app } = s;
    const { g } = await createPaidActive(env, app);
    const u = api(app, env, { id: 201, username: 'u201' });
    const c1 = (await u.post(`/api/g/${g.id}/challenge`)).json();
    expect((await u.post(`/api/g/${g.id}/join`, { challengeId: c1.challengeId, answer: 'ACDEFG' })).json().error.code).toBe('too_fast');
    const c2 = (await u.post(`/api/g/${g.id}/challenge`)).json();
    env.clock.advance(3000);
    expect((await u.post(`/api/g/${g.id}/join`, { challengeId: c2.challengeId, answer: 'WRONG1' })).json().error.code).toBe('captcha_wrong');
    expect((await u.post(`/api/g/${g.id}/join`, { challengeId: c2.challengeId, answer: 'ACDEFG' })).json().error.code).toBe('captcha_expired');
    expect((await u.post(`/api/g/${g.id}/join`, {})).json().error.code).toBe('captcha_required');
  });

  it('предусловия: username, подписка, страна', async () => {
    const { env, app } = s;
    const { g } = await createPaidActive(env, app, { countries: ['KZ'], captcha: false });
    // без ника участвовать можно (ник/получателя спросим только у победителя), но страна — обязательна
    expect((await api(app, env, { id: 301 }).post(`/api/g/${g.id}/join`)).json().error.code).toBe('need_phone');
    expect((await api(app, env, { id: 302, username: 'u302' }).post(`/api/g/${g.id}/join`)).json().error.code).toBe('need_phone');
    env.ctx.repo.setPhoneCountry(302, 'RU', env.clock.t);
    expect((await api(app, env, { id: 302, username: 'u302' }).post(`/api/g/${g.id}/join`)).json().error.code).toBe('country_not_allowed');
    env.ctx.repo.setPhoneCountry(303, 'KZ', env.clock.t);
    env.tg.members.set(303, 'left');
    await api(app, env, { id: 303, username: 'u303' }).get('/api/me'); // создаёт пользователя
    env.ctx.repo.setPhoneCountry(303, 'KZ', env.clock.t);
    expect((await api(app, env, { id: 303, username: 'u303' }).post(`/api/g/${g.id}/join`)).json().error.code).toBe('need_subscription');
    env.tg.members.set(303, 'member');
    const ok = await api(app, env, { id: 303, username: 'u303' }).post(`/api/g/${g.id}/join`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().me.joined).toBe(true);
    expect((await api(app, env, CREATOR).post(`/api/g/${g.id}/join`)).json().error.code).toBe('forbidden');
  });

  it('недоплата и доплата, дубликат транзакции', async () => {
    const { env, app } = s;
    const org = api(app, env, CREATOR);
    const g = (await org.post('/api/giveaways', baseInput())).json() as GiveawayOwnerView;
    const inv = (await org.post(`/api/giveaways/${g.id}/invoice`)).json() as InvoiceView;
    const half = BigInt(inv.amountNano) / 2n;
    const tx = { lt: '1', utime: env.clock.t / 1000, source: 'x', comment: `оплата ${inv.comment}`, aborted: false, bounced: false };
    await handleTx(env.ctx, { ...tx, hash: 'a', value: half });
    await handleTx(env.ctx, { ...tx, hash: 'a', value: half }); // дубликат
    let view = (await org.get(`/api/giveaways/${g.id}`)).json() as GiveawayOwnerView;
    expect(view.status).toBe('draft');
    expect(view.invoice!.status).toBe('underpaid');
    await handleTx(env.ctx, { ...tx, hash: 'b', lt: '2', value: BigInt(inv.amountNano) - half });
    view = (await org.get(`/api/giveaways/${g.id}`)).json() as GiveawayOwnerView;
    expect(view.status).toBe('paid');
  });

  it('без initData — 401, чужой розыгрыш — 404', async () => {
    const { env, app } = s;
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const g = (await api(app, env, CREATOR).post('/api/giveaways', baseInput())).json() as GiveawayOwnerView;
    expect((await api(app, env, { id: 55, username: 'x' }).get(`/api/giveaways/${g.id}`)).statusCode).toBe(404);
    expect((await api(app, env, { id: 55, username: 'x' }).get(`/api/g/${g.id}`)).statusCode).toBe(404); // черновик не виден
  });

  it('участников меньше, чем призов → возврат за остаток', async () => {
    const { env, app } = s;
    const { g, sched } = await createPaidActive(env, app, { winnersCount: 3, captcha: false });
    await api(app, env, { id: 401, username: 'u401' }).post(`/api/g/${g.id}/join`);
    env.clock.advance(3 * 86_400_000);
    await sched.tick();
    expect(env.ctx.repo.openRefunds()).toHaveLength(1);
    expect(env.ctx.repo.openRefunds()[0]!.usd_cents).toBe(2 * 199);
  });

  it('нет username у победителя → ждём и отправляем после claim', async () => {
    const { env, app } = s;
    const { g, sched } = await createPaidActive(env, app, { winnersCount: 1, captcha: false, requireSubscription: false });
    await api(app, env, { id: 501, username: 'u501' }).post(`/api/g/${g.id}/join`);
    env.ctx.repo.upsertUser({ id: 501, username: null, first_name: 'U' }, env.clock.t); // убрал username
    env.clock.advance(3 * 86_400_000);
    await sched.tick();
    expect(env.ctx.repo.getWinner(g.id, 501)!.status).toBe('needs_username');
    expect(env.tg.sent.some((m) => m.chatId === 501 && m.text.includes('нет публичного @username'))).toBe(true);
    env.tg.usernames.set(501, 'new501');
    env.clock.advance(7 * 3_600_000);
    await sched.tick(); // заметили новый ник → в очередь
    await sched.tick(); // отправили
    expect(env.provider.delivered.at(-1)!.username).toBe('new501');
  });
});

describe('публикация после оплаты', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it('после оплаты сам не публикуется; в ЛС приходит кнопка «Опубликовать сейчас»', async () => {
    const { env, app } = s;
    const { g, sched } = await createPaid(env, app);
    expect(g.status).toBe('paid');
    await sched.tick();
    expect(env.tg.channelPosts()).toHaveLength(0);
    const msg = env.tg.sent.find((m) => m.chatId === CREATOR.id && m.text.includes('Оплата получена'))!;
    expect(JSON.stringify(msg.opts!.reply_markup)).toContain(`pub:${g.id}`);
    // участник видит «скоро начнётся», но участвовать нельзя
    const v = (await api(app, env, { id: 70, username: 'u70' }).get(`/api/g/${g.id}`)).json() as PublicGiveawayView;
    expect(v.phase).toBe('upcoming');
  });

  it('по расписанию: пост выходит в выбранное время; до этого время можно перенести', async () => {
    const { env, app } = s;
    const { g, sched, org } = await createPaid(env, app);
    const at = env.clock.t + 2 * 3_600_000;
    const r = await org.post(`/api/giveaways/${g.id}/publish`, { at });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe('scheduled');
    expect(r.json().startsAt).toBe(at);
    env.clock.advance(3_600_000);
    await sched.tick();
    expect(env.tg.channelPosts()).toHaveLength(0);
    // перенос на +3 часа от текущего момента
    const later = env.clock.t + 3 * 3_600_000;
    expect((await org.post(`/api/giveaways/${g.id}/publish`, { at: later })).json().startsAt).toBe(later);
    env.clock.advance(1.5 * 3_600_000);
    await sched.tick();
    expect(env.tg.channelPosts()).toHaveLength(0);
    env.clock.advance(1.6 * 3_600_000);
    await sched.tick();
    expect(env.tg.channelPosts()).toHaveLength(1);
    expect((await org.get(`/api/giveaways/${g.id}`)).json().status).toBe('active');
    // после выхода поста — только 409
    expect((await org.post(`/api/giveaways/${g.id}/publish`, { at: null })).statusCode).toBe(409);
  });

  it('запланированный можно опубликовать сразу', async () => {
    const { env, app } = s;
    const { g, org } = await createPaid(env, app);
    await org.post(`/api/giveaways/${g.id}/publish`, { at: env.clock.t + 86_400_000 });
    const now = await org.post(`/api/giveaways/${g.id}/publish`, { at: null });
    expect(now.json().status).toBe('active');
    expect(env.tg.channelPosts()).toHaveLength(1);
  });

  it('проверки времени, оплаты и владельца', async () => {
    const { env, app } = s;
    const org = api(app, env, CREATOR);
    const draft = (await org.post('/api/giveaways', baseInput())).json() as GiveawayOwnerView;
    expect((await org.post(`/api/giveaways/${draft.id}/publish`, { at: null })).json().error.code).toBe('not_paid');
    const { g } = await createPaid(env, app);
    expect((await org.post(`/api/giveaways/${g.id}/publish`, { at: env.clock.t - 3_600_000 })).statusCode).toBe(400);
    expect((await org.post(`/api/giveaways/${g.id}/publish`, { at: g.endsAt - 60_000 })).json().error.message).toMatch(/до подведения итогов/);
    expect((await org.post(`/api/giveaways/${g.id}/publish`, { at: 'завтра' })).statusCode).toBe(400);
    expect((await api(app, env, { id: 77, username: 'x' }).post(`/api/giveaways/${g.id}/publish`, { at: null })).statusCode).toBe(404);
    expect(env.tg.channelPosts()).toHaveLength(0);
  });

  it('кнопка и планировщик одновременно — пост один', async () => {
    const { env, app } = s;
    const { g, org } = await createPaid(env, app);
    await org.post(`/api/giveaways/${g.id}/publish`, { at: env.clock.t + 60_000 });
    env.clock.advance(61_000);
    const row = env.ctx.repo.getGiveaway(g.id)!;
    // оба вызова видят статус scheduled до того, как кто-то из них отправил пост
    const results = await Promise.all([publishGiveaway(env.ctx, row), publishGiveaway(env.ctx, row)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(env.tg.channelPosts()).toHaveLength(1);
  });

  it('оплачен, но не опубликован до конца → отмена и возврат', async () => {
    const { env, app } = s;
    const { g, sched } = await createPaid(env, app);
    env.clock.advance(g.endsAt - env.clock.t - 5 * 60_000);
    await sched.tick();
    const repo = env.ctx.repo;
    expect(repo.getGiveaway(g.id)!.status).toBe('cancelled');
    expect(repo.openRefunds()[0]!.usd_cents).toBe(g.priceUsd * 100);
    expect(env.tg.channelPosts()).toHaveLength(0);
  });
});

describe('приз без ника: другой аккаунт, срок, доразыгрыш', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  async function finishedWith(env: TestEnv, app: FastifyInstance, players: { id: number; username?: string }[], input: Record<string, unknown> = {}) {
    const { g, sched } = await createPaidActive(env, app, { captcha: false, requireSubscription: false, ...input });
    for (const p of players) {
      const r = await api(app, env, p).post(`/api/g/${g.id}/join`);
      expect(r.statusCode, r.body).toBe(200);
    }
    env.clock.advance(3 * 86_400_000);
    await sched.tick(); // итоги
    return { g, sched };
  }

  it('участвует без ника; победив, указывает аккаунт друга — приз уходит туда', async () => {
    const { env, app } = s;
    const { g, sched } = await finishedWith(env, app, [{ id: 601 }], { winnersCount: 1 });
    await sched.tick();
    const u = api(app, env, { id: 601 });
    let v = (await u.get(`/api/g/${g.id}`)).json() as PublicGiveawayView;
    expect(v.me.prize).toMatchObject({ status: 'needs_username', issue: 'no_username' });
    expect(env.tg.sent.some((m) => m.chatId === 601 && m.text.includes('укажите в приложении другой аккаунт'))).toBe(true);

    const check = await u.post(`/api/g/${g.id}/claim/check`, { username: 't.me/best_friend' });
    expect(check.json()).toEqual({ username: 'best_friend', name: 'Пользователь @best_friend' });
    expect((await u.post(`/api/g/${g.id}/claim/check`, { username: 'a b' })).statusCode).toBe(400);
    // свой аккаунт без ника выбрать нельзя
    expect((await u.post(`/api/g/${g.id}/claim`, {})).json().error.code).toBe('need_username');

    v = (await u.post(`/api/g/${g.id}/claim`, { username: '@best_friend' })).json() as PublicGiveawayView;
    expect(v.me.prize).toMatchObject({ status: 'pending', recipient: 'best_friend' });
    await sched.tick();
    expect(env.provider.delivered.map((d) => d.username)).toEqual(['best_friend']);
    expect(((await u.get(`/api/g/${g.id}`)).json() as PublicGiveawayView).me.prize!.status).toBe('sent');
    // повторно поменять получателя после отправки нельзя
    expect((await u.post(`/api/g/${g.id}/claim`, { username: 'other1' })).statusCode).toBe(409);
    // чужой (не победитель) не может
    expect((await api(app, env, { id: 999, username: 'x999' }).post(`/api/g/${g.id}/claim`, { username: 'zzzz' })).statusCode).toBe(404);
  });

  it('Premium уже активен → победитель указывает другой аккаунт', async () => {
    const { env, app } = s;
    env.provider.rejects.set('hasprem', new DeliveryError('This user already has Telegram Premium.', 'ineligible'));
    const { g, sched } = await finishedWith(env, app, [{ id: 701, username: 'hasprem' }], { winnersCount: 1, prizeType: 'premium', prizeAmount: 3 });
    env.tg.usernames.set(701, 'hasprem');
    await sched.tick();
    const u = api(app, env, { id: 701, username: 'hasprem' });
    expect(((await u.get(`/api/g/${g.id}`)).json() as PublicGiveawayView).me.prize).toMatchObject({ status: 'needs_username', issue: 'ineligible' });
    // свой аккаунт снова не подойдёт — это видно сразу
    expect((await u.post(`/api/g/${g.id}/claim`, {})).json().error.message).toMatch(/уже есть Premium/);
    await u.post(`/api/g/${g.id}/claim`, { username: 'wife_acc' });
    await sched.tick();
    expect(env.provider.delivered.at(-1)).toMatchObject({ username: 'wife_acc', type: 'premium' });
  });

  it('не забрал в срок → напоминание → доразыгрыш тем же протоколом (проверка честности проходит)', async () => {
    const { env, app } = s;
    const players = [{ id: 801 }, { id: 802, username: 'p802' }, { id: 803, username: 'p803' }, { id: 804, username: 'p804' }];
    for (const p of players) if (p.username) env.tg.usernames.set(p.id, p.username);
    const { g, sched } = await createPaidActive(env, app, { captcha: false, requireSubscription: false, winnersCount: 1 });
    for (const p of players) expect((await api(app, env, p).post(`/api/g/${g.id}/join`)).statusCode).toBe(200);
    // детерминированно: подбираем seed, при котором первым выигрывает участник без ника (801)
    const entries = players.map((p) => ({ p: pseudonym(sha, g.id, p.id), t: 1 }));
    let seed = '';
    for (let i = 0; ; i++) {
      const r = await runDraw({ sha, seed: `seed-${i}`, entropy: 'AbCdEf0123456789', entries, winnersCount: 1 });
      if (r.winners[0] === pseudonym(sha, g.id, 801)) {
        seed = `seed-${i}`;
        break;
      }
    }
    env.ctx.repo.updateGiveaway(g.id, { seed, seed_hash: sha(seed) }, env.clock.t);
    env.clock.advance(3 * 86_400_000);
    await sched.tick(); // итоги
    await sched.tick();
    expect(env.ctx.repo.getWinner(g.id, 801)).toMatchObject({ status: 'needs_username', issue: 'no_username' });
    // за сутки до конца срока — напоминание
    env.clock.advance(6.2 * 86_400_000);
    await sched.tick();
    expect(env.tg.sent.some((m) => m.chatId === 801 && m.text.includes('Остались сутки'))).toBe(true);
    // срок вышел → доразыгрыш → новый победитель получает приз
    env.clock.advance(1 * 86_400_000);
    await sched.tick();
    await sched.tick();
    const ws = env.ctx.repo.listWinners(g.id);
    expect(ws.find((w) => w.user_id === 801)!.status).toBe('unclaimed');
    const fresh = ws.find((w) => w.user_id !== 801)!;
    expect(fresh.place).toBe(1);
    expect(env.provider.delivered.map((d) => d.username)).toEqual([env.ctx.repo.getUser(fresh.user_id)!.username]);
    expect(env.tg.channelPosts().some((p) => p.text.includes('Доразыгрыш'))).toBe(true);
    expect(env.tg.sent.some((m) => m.chatId === 801 && m.text.includes('разыгран заново'))).toBe(true);
    const pub = (await api(app, env, { id: 801 }).get(`/api/g/${g.id}`)).json() as PublicGiveawayView;
    expect(pub.me.isWinner).toBe(false);
    const proof = (await api(app, env, { id: 802 }).get(`/api/g/${g.id}/proof`)).json() as DrawProof;
    expect(proof.steps[0]).toMatchObject({ p: pseudonym(sha, g.id, 801), result: 'disqualified', reason: 'unclaimed' });
    expect((await verifyProof(sha, proof)).ok).toBe(true);
  });

  it('нет сессии Fragment → попытки не тратятся, админ получает кнопку входа', async () => {
    const { env, app } = s;
    env.tg.usernames.set(901, 'p901');
    env.provider.failNext = new DeliveryError('Fragment: не выполнен вход Telegram', 'auth');
    const { g, sched } = await finishedWith(env, app, [{ id: 901, username: 'p901' }], { winnersCount: 1 });
    await sched.tick();
    const w = env.ctx.repo.getWinner(g.id, 901)!;
    expect(w).toMatchObject({ status: 'pending', attempts: 0 });
    const alert = env.tg.sent.find((m) => m.chatId === 1 && m.text.includes('Fragment'))!;
    expect(JSON.stringify(alert.opts!.reply_markup)).toContain('fraglogin');
    env.clock.advance(11 * 60_000);
    await sched.tick();
    expect(env.provider.delivered.map((d) => d.username)).toEqual(['p901']);
  });
});
