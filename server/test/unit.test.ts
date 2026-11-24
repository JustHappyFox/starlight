import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { InitDataError, signInitData, validateInitData, verifySignedQuery } from '../src/tg/initData.js';
import { runDraw, verifyProof, uniform, pseudonym } from '../../shared/fairness.js';
import type { DrawProof } from '../../shared/types.js';
import { quote, usdCentsToNano, formatTon, unitPriceCents } from '../src/services/pricing.js';
import { loadConfig } from '../src/config.js';
import { sanitizeTelegramHtml } from '../src/util/html.js';
import { countryFromPhone, isCountryAllowed } from '../src/services/geo.js';
import { parseStartParam, Links } from '../src/services/links.js';
import { commentPayload, decodeComment } from '../src/ton/comment.js';
import { BOT_TOKEN } from './helpers.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('initData', () => {
  const now = Date.parse('2026-12-01T12:00:00Z');
  const fields = { auth_date: String(now / 1000), user: JSON.stringify({ id: 42, first_name: 'A', username: 'a' }), query_id: 'Q', signature: 'sig' };

  it('принимает корректную подпись (signature входит в data-check-string)', () => {
    const raw = signInitData(fields, BOT_TOKEN);
    const v = validateInitData(raw, BOT_TOKEN, 3600, now);
    expect(v.user.id).toBe(42);
  });
  it('отклоняет подделку', () => {
    const raw = signInitData(fields, BOT_TOKEN).replace('%22id%22%3A42', '%22id%22%3A43');
    expect(() => validateInitData(raw, BOT_TOKEN, 3600, now)).toThrow(InitDataError);
  });
  it('отклоняет чужой токен', () => {
    expect(() => validateInitData(signInitData(fields, '1:OTHER'), BOT_TOKEN, 3600, now)).toThrow(InitDataError);
  });
  it('отклоняет устаревшую', () => {
    expect(() => validateInitData(signInitData(fields, BOT_TOKEN), BOT_TOKEN, 3600, now + 7200_000)).toThrow(/устарела/);
  });
  it('проверяет подписанный ответ requestContact тем же алгоритмом', () => {
    const raw = signInitData({ auth_date: '1', contact: JSON.stringify({ user_id: 42, phone_number: '79001234567' }) }, BOT_TOKEN);
    expect(JSON.parse(verifySignedQuery(raw, BOT_TOKEN).contact!).user_id).toBe(42);
  });
});

describe('честный розыгрыш', () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ p: pseudonym(sha, 'G1', i + 1), t: 1 + (i % 5) }));

  it('детерминирован и без повторов', async () => {
    const a = await runDraw({ sha, seed: 's', entropy: 'e', entries, winnersCount: 10 });
    const b = await runDraw({ sha, seed: 's', entropy: 'e', entries: [...entries].reverse(), winnersCount: 10 });
    expect(a.winners).toEqual(b.winners);
    expect(new Set(a.winners).size).toBe(10);
    const c = await runDraw({ sha, seed: 's', entropy: 'other', entries, winnersCount: 10 });
    expect(c.winners).not.toEqual(a.winners);
  });

  it('вероятность пропорциональна билетам', async () => {
    const two = [
      { p: 'aaaa', t: 1 },
      { p: 'bbbb', t: 3 },
    ];
    let b = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const r = await runDraw({ sha, seed: String(i), entropy: '', entries: two, winnersCount: 1 });
      if (r.winners[0] === 'bbbb') b++;
    }
    expect(b / N).toBeGreaterThan(0.72);
    expect(b / N).toBeLessThan(0.78);
  });

  it('дисквалифицированный пропускается, розыгрыш продолжается', async () => {
    const r = await runDraw({ sha, seed: 'x', entropy: '', entries, winnersCount: 5, decide: (p) => ({ ok: p !== entries[0]!.p && p !== entries[1]!.p }) });
    expect(r.winners).toHaveLength(5);
    expect(r.winners).not.toContain(entries[0]!.p);
  });

  it('победителей не больше участников', async () => {
    const r = await runDraw({ sha, seed: 'x', entropy: '', entries: entries.slice(0, 3), winnersCount: 10 });
    expect(r.winners).toHaveLength(3);
  });

  it('verifyProof подтверждает и ловит подмену', async () => {
    const seed = 'secret-seed';
    const r = await runDraw({ sha, seed, entropy: 'ent', entries, winnersCount: 3, decide: (p) => ({ ok: p !== entries[7]!.p }) });
    const proof: DrawProof = {
      version: 1,
      giveawayId: 'G1',
      seed,
      seedHash: sha(seed),
      entropy: { source: 't', value: 'ent' },
      participantsHash: r.participantsHash,
      entries,
      steps: r.steps,
      winnersCount: 3,
    };
    expect((await verifyProof(sha, proof)).ok).toBe(true);
    const tampered = { ...proof, entries: proof.entries.map((e, i) => (i === 3 ? { ...e, t: e.t + 10 } : e)) };
    expect((await verifyProof(sha, tampered)).ok).toBe(false);
    expect((await verifyProof(sha, { ...proof, seed: 'other' })).ok).toBe(false);
  });

  it('uniform без смещения отбрасывает хвост', () => {
    const SPACE = 1n << 256n;
    const vals = [SPACE - 1n, 7n];
    expect(uniform(() => vals.shift()!, 3n)).toBe(1n);
  });
});

describe('цены', () => {
  const cfg = loadConfig({ BOT_TOKEN: 'x', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  it('звёзды по прайсу Telegram', () => {
    expect(unitPriceCents(cfg, 'stars', 100)).toBe(199);
    const q = quote(cfg, 'stars', 100, 3, 5);
    expect(q.totalUsd).toBeCloseTo(5.97);
    expect(BigInt(q.totalNano)).toBeGreaterThan(1_194_000_000n);
    expect(BigInt(q.totalNano) % 1_000_000n).toBe(0n);
    expect(q.costCents).toBeLessThan(q.totalCents);
  });
  it('premium по таблице', () => {
    expect(unitPriceCents(cfg, 'premium', 12)).toBe(3499);
    expect(() => unitPriceCents(cfg, 'premium', 5)).toThrow();
    expect(() => unitPriceCents(cfg, 'stars', 10)).toThrow();
  });
  it('конвертация в nano с округлением вверх', () => {
    expect(usdCentsToNano(500, 5, 0)).toBe(1_000_000_000n);
    expect(formatTon(1_234_000_000n)).toBe('1.234');
  });
});

describe('утилиты', () => {
  it('санитайзер HTML', () => {
    expect(sanitizeTelegramHtml('<b>ok</b> <script>x</script>')).toBe('<b>ok</b> &lt;script&gt;x&lt;/script&gt;');
    expect(sanitizeTelegramHtml('<a href="javascript:alert(1)">x</a>')).toContain('&lt;a');
    expect(sanitizeTelegramHtml('<a href="https://t.me/x">x</a>')).toBe('<a href="https://t.me/x">x</a>');
    expect(sanitizeTelegramHtml('<b>не закрыт')).toBe('<b>не закрыт</b>');
    expect(sanitizeTelegramHtml('1 < 2 & 3 > 2')).toBe('1 &lt; 2 &amp; 3 &gt; 2');
  });
  it('страна по телефону', () => {
    expect(countryFromPhone('79161234567')).toBe('RU');
    expect(countryFromPhone('+380501234567')).toBe('UA');
    expect(countryFromPhone('+77011234567')).toBe('KZ');
    expect(countryFromPhone('+88801234567')).toBeNull();
    expect(isCountryAllowed(['RU', 'KZ'], 'KZ')).toBe(true);
    expect(isCountryAllowed(['RU'], null)).toBe(false);
    expect(isCountryAllowed(null, null)).toBe(true);
  });
  it('startapp и ссылки', () => {
    expect(parseStartParam('Abc123xyz9_r4nd0m')).toEqual({ gid: 'Abc123xyz9', ref: 'r4nd0m' });
    expect(parseStartParam('bad param')).toBeNull();
    const l = new Links({ MINIAPP_SHORT_NAME: 'app', PUBLIC_URL: 'https://x.y' }, 'bot');
    expect(l.giveaway('Abc123xyz9', 'ref123')).toBe('https://t.me/bot/app?startapp=Abc123xyz9_ref123');
    expect(l.channelPost({ id: -1001234, username: null }, 5)).toBe('https://t.me/c/1234/5');
  });
  it('комментарий TON туда-обратно', () => {
    expect(decodeComment(commentPayload('SL-ABCDEFGH'))).toBe('SL-ABCDEFGH');
  });
});
