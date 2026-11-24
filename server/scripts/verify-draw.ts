// Независимая проверка розыгрыша: npm run verify -w server -- proof.json
// proof.json скачивается в мини-аппе на экране результатов (или GET /api/g/<id>/proof).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyProof, pseudonym } from '../../shared/fairness.js';
import type { DrawProof } from '../../shared/types.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const file = process.argv[2];
if (!file) {
  console.error('Использование: verify-draw <proof.json> [ваш_telegram_id]');
  process.exit(2);
}
const proof = JSON.parse(readFileSync(file, 'utf8')) as DrawProof;
const res = await verifyProof(sha, proof);
console.log(`Розыгрыш ${proof.giveawayId}: участников ${proof.entries.length}, билетов ${proof.entries.reduce((s, e) => s + e.t, 0)}`);
console.log(`Энтропия: ${proof.entropy.source} ${proof.entropy.value}`);
proof.steps.forEach((s) => console.log(`  шаг ${s.step}: ${s.p} → ${s.result}${s.reason ? ` (${s.reason})` : ''}`));
const myId = process.argv[3];
if (myId) {
  const p = pseudonym(sha, proof.giveawayId, myId);
  const mine = proof.entries.find((e) => e.p === p);
  console.log(mine ? `Ваш псевдоним ${p}: ${mine.t} билет(ов)` : `Псевдоним ${p} в списке не найден`);
}
if (res.ok) console.log('✅ Проверка пройдена: результат воспроизводится из опубликованных данных');
else {
  console.log('❌ Несовпадения:\n' + res.problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
