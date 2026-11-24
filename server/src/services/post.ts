import type { AppContext } from '../context.js';
import type { GiveawayRow } from '../db/repo.js';
import { escapeHtml, sanitizeTelegramHtml } from '../util/html.js';

export function prizeLabel(type: string, amount: number, html = true): string {
  if (type === 'stars') return `${amount.toLocaleString('ru-RU')} ⭐ Telegram Stars`;
  const m = amount === 12 ? '12 месяцев' : `${amount} месяцев`;
  return html ? `Telegram Premium на ${m}` : `Telegram Premium на ${m}`;
}

export function winnersWord(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return 'победитель';
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'победителя';
  return 'победителей';
}

export function formatDate(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(ms) + ` (${tz})`;
  } catch {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}

export function countryList(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) && a.length ? a : null;
  } catch {
    return null;
  }
}

/** Текст поста: текст автора + автоматический блок условий и гарантий */
export function renderPost(g: GiveawayRow): string {
  const body = sanitizeTelegramHtml(g.post_text.trim());
  const lines: string[] = [];
  lines.push(`🎁 <b>Приз:</b> ${escapeHtml(prizeLabel(g.prize_type, g.prize_amount))} × ${g.winners_count} ${winnersWord(g.winners_count)}`);
  lines.push(`⏳ <b>Итоги:</b> ${escapeHtml(formatDate(g.ends_at, g.timezone))}`);
  const cond: string[] = [];
  if (g.require_subscription) cond.push('подписка на канал');
  const countries = countryList(g.countries);
  if (countries) cond.push(`страны: ${countries.join(', ')}`);
  cond.push('публичный @username');
  lines.push(`✅ <b>Условия:</b> ${escapeHtml(cond.join(' · '))}`);
  lines.push('👥 Приглашайте друзей по своей ссылке — каждый друг даёт +1 билет.');
  lines.push('🛡 Призы оплачены заранее и выдаются ботом автоматически.');
  lines.push(`🔐 Хеш честности: <code>${g.seed_hash.slice(0, 16)}…</code>`);
  return `${body ? body + '\n\n' : ''}${lines.join('\n')}`;
}

export type ButtonPhase = 'active' | 'drawing' | 'finished';

export function buttonMarkup(ctx: AppContext, g: GiveawayRow, phase: ButtonPhase) {
  let text: string;
  if (phase === 'finished') text = '🏆 Результаты';
  else if (phase === 'drawing') text = '⏳ Подводим итоги…';
  else text = g.show_counter && g.participants_count > 0 ? `${g.button_text} (${g.participants_count})` : g.button_text;
  return { inline_keyboard: [[{ text, url: ctx.links.giveaway(g.id) }]] };
}

export function renderResults(g: GiveawayRow, winners: { place: number; username: string | null; first_name: string | null }[]): string {
  const lines = [`🏆 <b>Итоги розыгрыша</b>`, `🎁 ${escapeHtml(prizeLabel(g.prize_type, g.prize_amount))}`, ''];
  if (!winners.length) {
    lines.push('Участников не набралось — призы не разыграны.');
  } else {
    for (const w of winners) {
      const who = w.username ? `@${escapeHtml(w.username)}` : escapeHtml(w.first_name || 'Участник');
      lines.push(`${w.place}. ${who}`);
    }
  }
  lines.push('', `👥 Участников: ${g.participants_count}`, `🔐 Проверка честности — по кнопке «Результаты».`);
  return lines.join('\n');
}
