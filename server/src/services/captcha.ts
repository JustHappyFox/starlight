import svgCaptcha from 'svg-captcha';
import sharp from 'sharp';
import { randomInt } from 'node:crypto';
import type { Repo } from '../db/repo.js';
import { hmacHex, randomId } from '../util/ids.js';

// Без похожих символов: 0/O, 1/I/L, 5/S, 2/Z, 8/B
const CHARSET = 'ACDEFGHJKMNPQRTUVWXY34679';

export type CaptchaVerdict = 'ok' | 'wrong' | 'expired' | 'too_fast' | 'missing';

export interface CaptchaOptions {
  secret: string;
  ttlSec: number;
  minSolveMs: number;
  length?: number;
}

/**
 * Картинка-капча: SVG (буквы как кривые, без <text>) → растеризация в PNG через sharp,
 * поверх — дополнительный шум. Ответ хранится только как HMAC, капча одноразовая.
 */
export class CaptchaService {
  constructor(
    private repo: Repo,
    private opts: CaptchaOptions,
  ) {}

  private hash(id: string, answer: string) {
    return hmacHex(this.opts.secret, `${id}:${answer.trim().toUpperCase()}`);
  }

  async render(): Promise<{ text: string; png: Buffer }> {
    const width = 260;
    const height = 96;
    const c = svgCaptcha.create({
      size: this.opts.length ?? 6,
      charPreset: CHARSET,
      noise: 4,
      color: true,
      background: '#eef1f6',
      width,
      height,
      fontSize: 78,
    });
    const svg = addNoise(c.data, width, height);
    const png = await sharp(Buffer.from(svg), { density: 144 }).png({ compressionLevel: 9 }).toBuffer();
    return { text: c.text, png };
  }

  async create(giveawayId: string, userId: number, now: number) {
    const { text, png } = await this.render();
    const id = randomId(16);
    this.repo.insertCaptcha({
      id,
      giveaway_id: giveawayId,
      user_id: userId,
      answer_hash: this.hash(id, text),
      created_at: now,
      expires_at: now + this.opts.ttlSec * 1000,
    });
    return { challengeId: id, image: `data:image/png;base64,${png.toString('base64')}`, expiresAt: now + this.opts.ttlSec * 1000, text };
  }

  /** Проверка расходует капчу при любом исходе, кроме missing. */
  verify(challengeId: string | undefined, giveawayId: string, userId: number, answer: string | undefined, now: number): { verdict: CaptchaVerdict; solveMs?: number } {
    if (!challengeId || !answer) return { verdict: 'missing' };
    const c = this.repo.getCaptcha(challengeId);
    if (!c || c.giveaway_id !== giveawayId || c.user_id !== userId) return { verdict: 'missing' };
    if (!this.repo.consumeCaptcha(c.id)) return { verdict: 'expired' };
    if (now > c.expires_at) return { verdict: 'expired' };
    const solveMs = now - c.created_at;
    if (solveMs < this.opts.minSolveMs) return { verdict: 'too_fast', solveMs };
    if (this.hash(c.id, answer) !== c.answer_hash) return { verdict: 'wrong', solveMs };
    return { verdict: 'ok', solveMs };
  }
}

function rnd(min: number, max: number) {
  return min + randomInt(Math.max(1, max - min));
}

function addNoise(svg: string, w: number, h: number): string {
  const parts: string[] = [];
  // волнистые линии через весь текст
  for (let i = 0; i < 3; i++) {
    const y0 = rnd(15, h - 15);
    const c1 = rnd(0, h);
    const c2 = rnd(0, h);
    const y1 = rnd(15, h - 15);
    const color = `hsl(${rnd(0, 360)},55%,45%)`;
    parts.push(`<path d="M0 ${y0} C ${w / 3} ${c1}, ${(2 * w) / 3} ${c2}, ${w} ${y1}" stroke="${color}" stroke-width="${rnd(2, 4)}" fill="none" opacity="0.75"/>`);
  }
  // точки
  for (let i = 0; i < 90; i++) {
    parts.push(`<circle cx="${rnd(0, w)}" cy="${rnd(0, h)}" r="${rnd(1, 3)}" fill="hsl(${rnd(0, 360)},40%,${rnd(35, 70)}%)" opacity="0.6"/>`);
  }
  return svg.replace('</svg>', `${parts.join('')}</svg>`);
}
