// Доказуемо честный розыгрыш (commit–reveal).
//
// 1. При публикации сервер генерирует секретный seed и публикует sha256(seed).
// 2. В момент подведения итогов фиксируется список участников с билетами
//    (participantsHash) и внешняя энтропия (хеш последнего блока мастерчейна TON).
// 3. finalSeed = sha256(seed:participantsHash:entropy); случайные числа —
//    sha256(finalSeed:i) как 256-битное число, равномерно без смещения (rejection sampling).
// 4. Каждый шаг выбирает билет среди оставшихся; владелец билета выбывает из пула
//    (один человек — максимум один приз). Если победитель не прошёл финальную проверку
//    (например, отписался от канала), он помечается disqualified и розыгрыш продолжается.
//
// Модуль чистый и детерминированный: используется и сервером, и скриптом проверки.

import type { DrawProof } from './types.js';

export type Sha256Hex = (input: string) => string;

export interface DrawEntry {
  /** Псевдоним участника */
  p: string;
  /** Количество билетов (>= 1) */
  t: number;
}

export interface DrawStep {
  step: number;
  p: string;
  result: 'win' | 'disqualified';
  reason?: string;
}

export type Decide = (p: string) => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };

export function pseudonym(sha: Sha256Hex, giveawayId: string, userId: number | string): string {
  return sha(`${giveawayId}:${userId}`).slice(0, 16);
}

export function canonicalEntries(entries: DrawEntry[]): DrawEntry[] {
  return [...entries]
    .filter((e) => Number.isInteger(e.t) && e.t > 0)
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
}

export function participantsHash(sha: Sha256Hex, entries: DrawEntry[]): string {
  return sha(canonicalEntries(entries).map((e) => `${e.p}:${e.t}`).join('\n'));
}

export function finalSeed(sha: Sha256Hex, seed: string, pHash: string, entropy: string): string {
  return sha(`${seed}:${pHash}:${entropy}`);
}

const SPACE = 1n << 256n;

/** Равномерное целое в [0, n) из потока 256-битных чисел без смещения по модулю. */
export function uniform(next: () => bigint, n: bigint): bigint {
  if (n <= 0n) throw new Error('uniform: n must be positive');
  const limit = SPACE - (SPACE % n);
  for (;;) {
    const v = next();
    if (v < limit) return v % n;
  }
}

export function makeStream(sha: Sha256Hex, seedHex: string): () => bigint {
  let i = 0;
  return () => BigInt('0x' + sha(`${seedHex}:${i++}`));
}

export async function runDraw(opts: {
  sha: Sha256Hex;
  seed: string;
  entropy: string;
  entries: DrawEntry[];
  winnersCount: number;
  decide?: Decide;
}): Promise<{ steps: DrawStep[]; winners: string[]; participantsHash: string; finalSeed: string }> {
  const { sha, seed, entropy, winnersCount } = opts;
  const pool = canonicalEntries(opts.entries);
  const pHash = participantsHash(sha, pool);
  const fSeed = finalSeed(sha, seed, pHash, entropy);
  const next = makeStream(sha, fSeed);
  const steps: DrawStep[] = [];
  const winners: string[] = [];
  let step = 0;

  while (winners.length < winnersCount && pool.length > 0) {
    const total = pool.reduce((s, e) => s + BigInt(e.t), 0n);
    const r = uniform(next, total);
    let acc = 0n;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      acc += BigInt(pool[idx]!.t);
      if (r < acc) break;
    }
    const picked = pool[idx]!;
    pool.splice(idx, 1);
    const verdict = opts.decide ? await opts.decide(picked.p) : { ok: true };
    if (verdict.ok) {
      winners.push(picked.p);
      steps.push({ step, p: picked.p, result: 'win' });
    } else {
      steps.push({ step, p: picked.p, result: 'disqualified', reason: verdict.reason });
    }
    step++;
  }
  return { steps, winners, participantsHash: pHash, finalSeed: fSeed };
}

/** Повторяет розыгрыш по опубликованным данным и сверяет каждый шаг. */
export async function verifyProof(sha: Sha256Hex, proof: DrawProof): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  if (sha(proof.seed) !== proof.seedHash) problems.push('sha256(seed) не совпадает с опубликованным seedHash');
  const recorded = new Map(proof.steps.map((s) => [s.p, s]));
  const replay = await runDraw({
    sha,
    seed: proof.seed,
    entropy: proof.entropy.value,
    entries: proof.entries,
    winnersCount: proof.winnersCount,
    decide: (p) => {
      const s = recorded.get(p);
      return { ok: s?.result === 'win', reason: s?.reason };
    },
  });
  if (replay.participantsHash !== proof.participantsHash) problems.push('participantsHash не совпадает со списком участников');
  if (replay.steps.length !== proof.steps.length) problems.push(`число шагов: ожидалось ${proof.steps.length}, получено ${replay.steps.length}`);
  replay.steps.forEach((s, i) => {
    const r = proof.steps[i];
    if (!r || r.p !== s.p) problems.push(`шаг ${i}: выбран ${s.p}, в протоколе ${r?.p ?? '—'}`);
  });
  return { ok: problems.length === 0, problems };
}
