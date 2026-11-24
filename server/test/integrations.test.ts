import { describe, expect, it, vi } from 'vitest';
import { Address } from '@ton/core';
import { signVerify } from '@ton/crypto';
import { createHash } from 'node:crypto';
import { FragmentProvider } from '../src/fulfillment/fragment.js';
import { FragmentSession, embeddedObject, classifyFragmentError } from '../src/fulfillment/fragmentSession.js';
import { DeliveryError } from '../src/fulfillment/provider.js';
import { NoopTreasury } from '../src/treasury/index.js';
import { TonCenter } from '../src/ton/toncenter.js';
import { commentPayload } from '../src/ton/comment.js';
import { logger } from '../src/util/logger.js';
import { ServiceWallet, type WalletLike } from '../src/ton/wallet.js';
import { openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

async function testWallet(): Promise<WalletLike & { sent: unknown[] }> {
  const real = await ServiceWallet.create({ mnemonic: MNEMONIC, version: 'v5r1', endpoint: 'https://toncenter.invalid', testnet: false, log: logger });
  const sent: unknown[] = [];
  return {
    sent,
    address: real.address,
    balance: async () => 10_000_000_000n,
    send: async (messages) => {
      sent.push(messages);
      return { seqno: 7, boc: real.buildTransferBoc(7, messages) };
    },
    tonConnectAccount: () => real.tonConnectAccount(),
    tonProof: (d, p, t) => real.tonProof(d, p, t),
  };
}

/** Независимая проверка ton_proof по спецификации TON Connect */
function verifyTonProof(account: { address: string; publicKey: string }, proof: { timestamp: number; domain: { value: string }; payload: string; signature: string }) {
  const addr = Address.parse(account.address);
  const wc = Buffer.alloc(4);
  wc.writeInt32BE(addr.workChain);
  const dom = Buffer.from(proof.domain.value);
  const dl = Buffer.alloc(4);
  dl.writeUInt32LE(dom.length);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(proof.timestamp));
  const msg = Buffer.concat([Buffer.from('ton-proof-item-v2/'), wc, addr.hash, dl, dom, ts, Buffer.from(proof.payload)]);
  const digest = createHash('sha256')
    .update(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), createHash('sha256').update(msg).digest()]))
    .digest();
  return signVerify(digest, Buffer.from(proof.signature, 'base64'), Buffer.from(account.publicKey, 'hex'));
}

const FRAG_ADDR = 'EQBAjaOyi2wGWlk-EDkSabqqnF-MrrwMadnwqrurKpkla9nE';

/** Фейковые fragment.com + oauth.telegram.org */
function fakeFragment(opts: { premiumActive?: boolean } = {}) {
  const log: string[] = [];
  const state = { tonToken: 0, tgToken: 0, confirmed: false, boc: '', killSession: false, oauthPolls: 0 };
  const cookieOf = (init?: RequestInit) => String((init?.headers as Record<string, string> | undefined)?.cookie ?? '');
  const json = (body: unknown, cookies: string[] = []) => {
    const h = new Headers({ 'content-type': 'application/json' });
    cookies.forEach((c) => h.append('set-cookie', c));
    return new Response(JSON.stringify(body), { headers: h });
  };
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.host === 'oauth.telegram.org') {
      log.push(`oauth:${u.pathname}`);
      if (u.pathname === '/auth/auth') return new Response(`<script>Login.setToken('QT1')</script>`, { headers: { 'set-cookie': 'stel_ssid=o1; path=/' } });
      if (u.pathname === '/auth/login') return json(++state.oauthPolls < 2 ? { status: 'wait' } : { status: 'confirmed' });
      if (u.pathname === '/auth/push') return new Response(`<script>location.hash='tgAuthResult=AUTHRES'</script>`);
    }
    if (!u.pathname.startsWith('/api')) {
      log.push(`page:${u.pathname}`);
      return new Response(`<script>ajInit({"apiUrl":"\\/api?hash=abc123"});Wallet.init({"ton_proof":"CHALLENGE-1","x":{"y":"}"}});</script>`, {
        headers: { 'set-cookie': 'stel_ssid=s1; path=/; HttpOnly' },
      });
    }
    const body = new URLSearchParams(String(init?.body));
    const method = body.get('method')!;
    log.push(method);
    const cookies = cookieOf(init);
    const authed = cookies.includes('stel_token=') && cookies.includes('stel_ton_token=') && !state.killSession;
    switch (method) {
      case 'checkTonProofAuth': {
        const ok = verifyTonProof(JSON.parse(body.get('account')!), JSON.parse(body.get('proof')!));
        if (!ok || JSON.parse(body.get('proof')!).payload !== 'CHALLENGE-1') return json({ error: 'Invalid proof' });
        state.killSession = false;
        return json({ ok: true }, [`stel_ton_token=ton${++state.tonToken}; path=/`]);
      }
      case 'logIn':
        return body.get('auth') === 'AUTHRES' ? json({ ok: true }, [`stel_token=tg${++state.tgToken}; path=/`]) : json({ error: 'bad auth' });
      case 'updateStarsBuyState':
      case 'updatePremiumState':
        if (body.get('id')) return json(state.confirmed ? { mode: 'done', need_update: false, req_id: body.get('id') } : { mode: 'new', need_update: true });
        return json({ ok: true });
    }
    if (!authed) return json({ error: 'Access denied. Please log in.' });
    switch (method) {
      case 'searchStarsRecipient':
      case 'searchPremiumGiftRecipient':
        if (body.get('query') === 'nobody') return json({ error: 'No Telegram users found.' });
        if (method === 'searchPremiumGiftRecipient' && opts.premiumActive) return json({ error: 'This user already has Telegram Premium.' });
        return json({ ok: true, found: { recipient: 'RCPT', name: 'Winner Name' } });
      case 'initBuyStarsRequest':
      case 'initGiftPremiumRequest':
        return json({ req_id: 'REQ1', amount: '0.3' });
      case 'getBuyStarsLink':
      case 'getGiftPremiumLink':
        return json({ ok: true, transaction: { validUntil: 1, messages: [{ address: FRAG_ADDR, amount: '300000000', payload: commentPayload('50 Telegram Stars Ref#x') }], confirm_method: 'confirmReq', confirm_params: { id: 'REQ1' } } });
      case 'confirmReq':
        state.boc = body.get('boc') ?? '';
        state.confirmed = true;
        return json({ ok: true });
    }
    return json({ error: `unknown method ${method}` });
  });
  return { fn: fn as unknown as typeof fetch, log, state };
}

async function makeSession(f: ReturnType<typeof fakeFragment>, wallet?: WalletLike) {
  const repo = new Repo(openDb(':memory:'));
  const w = wallet ?? (await testWallet());
  const session = new FragmentSession({ repo, wallet: w, log: logger, fetchFn: f.fn, sleep: async () => {} });
  return { repo, session, wallet: w };
}

describe('Fragment: сессия без ручных куки', () => {
  it('вход кошельком (ton_proof проходит независимую проверку) + вход Telegram по ссылке t.me/oauth', async () => {
    const f = fakeFragment();
    const { session, repo } = await makeSession(f);
    expect(session.state.telegram).toBe(false);
    const links: string[] = [];
    await session.telegramLogin((l) => {
      links.push(l);
    });
    expect(links).toEqual(['https://t.me/oauth?startapp=QT1']);
    expect(f.log).toContain('checkTonProofAuth');
    expect(f.log).toContain('logIn');
    expect(session.state).toMatchObject({ wallet: true, telegram: true });
    // куки сохранены в БД и переживают перезапуск
    const again = new FragmentSession({ repo, wallet: null, log: logger, fetchFn: f.fn });
    expect(again.state).toMatchObject({ wallet: true, telegram: true });
  });

  it('сессия кошелька умерла → перевход сам, вызов повторяется', async () => {
    const f = fakeFragment();
    const { session } = await makeSession(f);
    await session.telegramLogin(() => {});
    f.state.killSession = true;
    expect(await session.healthCheck('durov')).toBe(true);
    expect(f.log.filter((m) => m === 'checkTonProofAuth')).toHaveLength(2);
  });

  it('без входа Telegram — ошибка auth (выдача ждёт, попытки не тратятся)', async () => {
    const f = fakeFragment();
    const { session } = await makeSession(f);
    expect(await session.healthCheck('durov')).toBe(false);
    expect(session.state.lastError).toMatch(/вход Telegram/);
  });

  it('разбор страницы и классификация ошибок', () => {
    expect(embeddedObject('a Wallet.init({"ton_proof":"x}{","n":{"m":1}}); b', 'Wallet.init(')).toEqual({ ton_proof: 'x}{', n: { m: 1 } });
    expect(classifyFragmentError('No Telegram users found.')).toBe('recipient');
    expect(classifyFragmentError('This user already has Telegram Premium.')).toBe('ineligible');
    expect(classifyFragmentError('Access denied')).toBe('auth');
    expect(classifyFragmentError('Server is busy')).toBe('retry');
  });
});

describe('Fragment: покупка', () => {
  async function ready(opts?: Parameters<typeof fakeFragment>[0]) {
    const f = fakeFragment(opts);
    const wallet = await testWallet();
    const { session } = await makeSession(f, wallet);
    await session.telegramLogin(() => {});
    f.log.length = 0;
    return { f, session, wallet };
  }

  it('stars: полный поток, подписанная транзакция уходит в confirmReq, ждём done', async () => {
    const { f, session, wallet } = await ready();
    const p = new FragmentProvider({ session, wallet, treasury: new NoopTreasury(), dryRun: false, log: logger, sleep: async () => {} });
    const r = await p.deliver({ type: 'stars', amount: 50, username: '@winner', ref: 'g:1' });
    expect(f.log).toEqual(['updateStarsBuyState', 'searchStarsRecipient', 'initBuyStarsRequest', 'getBuyStarsLink', 'confirmReq', 'updateStarsBuyState']);
    expect(wallet.sent).toHaveLength(1);
    expect(f.state.boc.length).toBeGreaterThan(100);
    expect(r).toMatchObject({ providerRef: 'REQ1', txRef: 'seqno:7', costNano: '300000000', confirmed: true });
  });

  it('dry-run: заказ создаётся, но денег не отправляем', async () => {
    const { f, session, wallet } = await ready();
    const p = new FragmentProvider({ session, wallet, treasury: new NoopTreasury(), dryRun: true, log: logger });
    const r = await p.deliver({ type: 'stars', amount: 50, username: 'w', ref: 'x' });
    expect(wallet.sent).toHaveLength(0);
    expect(f.log).not.toContain('confirmReq');
    expect(r.confirmed).toBe(false);
  });

  it('premium: методы подарка; lookup показывает имя получателя', async () => {
    const { f, session, wallet } = await ready();
    const p = new FragmentProvider({ session, wallet, treasury: new NoopTreasury(), dryRun: true, log: logger });
    expect(await p.lookup({ type: 'premium', amount: 3, username: 'w' })).toEqual({ name: 'Winner Name' });
    expect(f.log).toEqual(['updatePremiumState', 'searchPremiumGiftRecipient']);
  });

  it('нет такого ника → recipient; Premium уже активен → ineligible', async () => {
    const a = await ready();
    const p1 = new FragmentProvider({ session: a.session, wallet: a.wallet, treasury: new NoopTreasury(), dryRun: true, log: logger });
    expect(((await p1.deliver({ type: 'stars', amount: 50, username: 'nobody', ref: 'x' }).catch((e) => e)) as DeliveryError).kind).toBe('recipient');
    const b = await ready({ premiumActive: true });
    const p2 = new FragmentProvider({ session: b.session, wallet: b.wallet, treasury: new NoopTreasury(), dryRun: true, log: logger });
    expect(((await p2.deliver({ type: 'premium', amount: 3, username: 'w', ref: 'x' }).catch((e) => e)) as DeliveryError).kind).toBe('ineligible');
  });

  it('подозрительная сумма → fatal, деньги не уходят', async () => {
    const { f, session, wallet } = await ready();
    const base = f.fn;
    const patched = (async (url: string | URL, init?: RequestInit) => {
      const r = await base(url, init);
      if (String(init?.body ?? '').includes('method=getBuyStarsLink')) {
        return new Response(JSON.stringify({ transaction: { messages: [{ address: FRAG_ADDR, amount: '999999999999999' }] } }));
      }
      return r;
    }) as typeof fetch;
    (session as unknown as { o: { fetchFn: typeof fetch } }).o.fetchFn = patched;
    const p = new FragmentProvider({ session, wallet, treasury: new NoopTreasury(), dryRun: false, log: logger });
    expect(((await p.deliver({ type: 'stars', amount: 50, username: 'w', ref: 'x' }).catch((e) => e)) as DeliveryError).kind).toBe('fatal');
    expect(wallet.sent).toHaveLength(0);
  });
});

describe('сервисный кошелёк (офлайн)', () => {
  it('выводит адрес и TON Connect-аккаунт из мнемоники (v5r1 и v4)', async () => {
    const { mnemonicNew } = await import('@ton/crypto');
    const { ServiceWallet } = await import('../src/ton/wallet.js');
    const m = (await mnemonicNew(24)).join(' ');
    const addrs = new Set<string>();
    for (const version of ['v5r1', 'v4'] as const) {
      const w = await ServiceWallet.create({ mnemonic: m, version, endpoint: 'https://toncenter.com/api/v2/jsonRPC', testnet: false, log: logger });
      expect(w.address).toMatch(/^UQ/);
      const acc = w.tonConnectAccount();
      expect(acc.address).toMatch(/^0:[0-9a-f]{64}$/);
      expect(acc.chain).toBe('-239');
      expect(acc.publicKey).toMatch(/^[0-9a-f]{64}$/);
      addrs.add(w.address);
    }
    expect(addrs.size).toBe(2);
    await expect(ServiceWallet.create({ mnemonic: 'a b c', version: 'v4', endpoint: 'x', testnet: false, log: logger })).rejects.toThrow(/24 слова/);
  });
});

describe('toncenter', () => {
  it('разбирает входящие с комментарием (decoded и сырой body)', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          transactions: [
            {
              hash: 'h1',
              lt: '200',
              now: 1700000000,
              description: { aborted: false },
              in_msg: { source: '0:' + 'a'.repeat(64), value: '1500000000', message_content: { decoded: { type: 'text_comment', comment: 'SL-ABCDEFGH' } } },
            },
            {
              hash: 'h2',
              lt: '199',
              now: 1700000000,
              in_msg: { source: '0:' + 'b'.repeat(64), value: '10', message_content: { body: commentPayload('SL-ZZZZZZZZ') } },
            },
            { hash: 'h3', lt: '198', now: 1, in_msg: { source: null, value: null } },
          ],
        }),
      ),
    ) as unknown as typeof fetch;
    const tc = new TonCenter({ base: 'https://toncenter.com', fetchFn });
    const txs = await tc.incoming('UQx');
    expect(txs).toHaveLength(2);
    expect(txs[0]!.comment).toBe('SL-ABCDEFGH');
    expect(txs[0]!.value).toBe(1_500_000_000n);
    expect(txs[0]!.source).toMatch(/^UQ/);
    expect(txs[1]!.comment).toBe('SL-ZZZZZZZZ');
  });
});
