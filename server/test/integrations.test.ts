import { describe, expect, it, vi } from 'vitest';
import { FragmentProvider } from '../src/fulfillment/fragment.js';
import { DeliveryError } from '../src/fulfillment/provider.js';
import { NoopTreasury } from '../src/treasury/index.js';
import { TonCenter } from '../src/ton/toncenter.js';
import { commentPayload } from '../src/ton/comment.js';
import { logger } from '../src/util/logger.js';
import type { WalletLike } from '../src/ton/wallet.js';

const wallet: WalletLike = {
  address: 'UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG',
  balance: async () => 10_000_000_000n,
  send: vi.fn(async () => ({ seqno: 7 })),
  tonConnectAccount: () => ({ address: '0:abc', chain: '-239', walletStateInit: 'te6', publicKey: 'ff' }),
};

function fragmentFetch(responses: Record<string, unknown>) {
  const calls: { method: string; body: URLSearchParams }[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes('/api?hash=')) return new Response('<script>ajInit({"apiUrl":"\\/api?hash=deadbeef01"})</script>');
    const body = new URLSearchParams(String(init?.body));
    const method = body.get('method')!;
    calls.push({ method, body });
    return new Response(JSON.stringify(responses[method] ?? { error: 'unknown method' }));
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const starsOk = {
  searchStarsRecipient: { ok: true, found: { recipient: 'RCPT', name: 'Winner' } },
  initBuyStarsRequest: { req_id: 'REQ1', amount: '0.3' },
  getBuyStarsLink: {
    ok: true,
    transaction: { validUntil: 1, messages: [{ address: 'EQBAjaOyi2wGWlk-EDkSabqqnF-MrrwMadnwqrurKpkla9nE', amount: '300000000', payload: commentPayload('50 Telegram Stars Ref#x') }] },
  },
};

describe('Fragment', () => {
  it('stars: полный поток в dry-run, hash берётся со страницы', async () => {
    const { fn, calls } = fragmentFetch(starsOk);
    const p = new FragmentProvider({ cookies: 'stel_ssid=1', wallet, treasury: new NoopTreasury(), dryRun: true, log: logger, fetchFn: fn });
    const r = await p.deliver({ type: 'stars', amount: 50, username: '@winner', ref: 'g:1' });
    expect(calls.map((c) => c.method)).toEqual(['searchStarsRecipient', 'initBuyStarsRequest', 'getBuyStarsLink']);
    expect(calls[0]!.body.get('query')).toBe('winner');
    expect(JSON.parse(calls[2]!.body.get('account')!).chain).toBe('-239');
    expect(r.costNano).toBe('300000000');
    expect(wallet.send).not.toHaveBeenCalled();
  });

  it('stars: боевой режим отправляет перевод кошельком', async () => {
    const { fn } = fragmentFetch(starsOk);
    const p = new FragmentProvider({ cookies: 'c', hash: 'h', wallet, treasury: new NoopTreasury(), dryRun: false, log: logger, fetchFn: fn });
    const r = await p.deliver({ type: 'stars', amount: 50, username: 'winner', ref: 'g:1' });
    expect(wallet.send).toHaveBeenCalledOnce();
    expect(r.txRef).toBe('seqno:7');
  });

  it('premium: методы gift', async () => {
    const { fn, calls } = fragmentFetch({
      searchPremiumGiftRecipient: { found: { recipient: 'R' } },
      initGiftPremiumRequest: { req_id: 'P1' },
      getGiftPremiumLink: { transaction: { messages: [{ address: 'EQBAjaOyi2wGWlk-EDkSabqqnF-MrrwMadnwqrurKpkla9nE', amount: '2500000000' }] } },
    });
    const p = new FragmentProvider({ cookies: 'c', hash: 'h', wallet, treasury: new NoopTreasury(), dryRun: true, log: logger, fetchFn: fn });
    await p.deliver({ type: 'premium', amount: 3, username: 'w', ref: 'g:2' });
    expect(calls.map((c) => c.method)).toEqual(['searchPremiumGiftRecipient', 'initGiftPremiumRequest', 'getGiftPremiumLink']);
    expect(calls[0]!.body.get('months')).toBe('3');
  });

  it('получатель не найден → recipient', async () => {
    const { fn } = fragmentFetch({ searchStarsRecipient: { error: 'No Telegram users found.' } });
    const p = new FragmentProvider({ cookies: 'c', hash: 'h', wallet, treasury: new NoopTreasury(), dryRun: true, log: logger, fetchFn: fn });
    const e = await p.deliver({ type: 'stars', amount: 50, username: 'nobody', ref: 'x' }).catch((x) => x);
    expect(e).toBeInstanceOf(DeliveryError);
    expect((e as DeliveryError).kind).toBe('recipient');
  });

  it('подозрительная сумма → fatal', async () => {
    const { fn } = fragmentFetch({
      ...starsOk,
      getBuyStarsLink: { transaction: { messages: [{ address: 'EQBAjaOyi2wGWlk-EDkSabqqnF-MrrwMadnwqrurKpkla9nE', amount: '999999999999999' }] } },
    });
    const p = new FragmentProvider({ cookies: 'c', hash: 'h', wallet, treasury: new NoopTreasury(), dryRun: true, log: logger, fetchFn: fn });
    const e = await p.deliver({ type: 'stars', amount: 50, username: 'w', ref: 'x' }).catch((x) => x);
    expect((e as DeliveryError).kind).toBe('fatal');
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
