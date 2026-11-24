import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { onBotMembership } from '../src/bot/channels.js';
import { startScheduler } from '../src/services/scheduler.js';
import { handleTx } from '../src/ton/payments.js';
import { verifyProof } from '../../shared/fairness.js';
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

async function createPaidActive(env: TestEnv, app: FastifyInstance, input: Record<string, unknown> = {}) {
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
    expect((await api(app, env, { id: 301 }).post(`/api/g/${g.id}/join`)).json().error.code).toBe('need_username');
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
    expect(view.status).toBe('scheduled');
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
    await sched.tick();
    expect(env.provider.delivered.at(-1)!.username).toBe('new501');
  });
});
