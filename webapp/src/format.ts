import type { PrizeType } from '../../shared/types';

export function prizeTitle(type: PrizeType, amount: number): string {
  if (type === 'stars') return `${amount.toLocaleString('ru-RU')} ⭐`;
  return `Premium · ${amount} мес.`;
}

export function prizeLong(type: PrizeType, amount: number): string {
  if (type === 'stars') return `${amount.toLocaleString('ru-RU')} Telegram Stars`;
  return `Telegram Premium на ${amount} месяцев`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}

export function dateTime(ms: number): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(ms);
}

export function left(ms: number): string {
  if (ms <= 0) return 'завершён';
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d} д ${h} ч`;
  if (h > 0) return `${h} ч ${mm} мин`;
  return `${Math.max(1, mm)} мин`;
}

/** ms → значение для <input type="datetime-local"> в локальном времени */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): number | null {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Черновик · ждёт оплаты',
  scheduled: 'Оплачен · ждёт публикации',
  active: 'Идёт',
  drawing: 'Подводим итоги',
  finished: 'Завершён',
  cancelled: 'Отменён',
};

export const PRIZE_STATUS: Record<string, string> = {
  pending: 'в очереди',
  processing: 'отправляется',
  sent: 'отправлен ✓',
  needs_username: 'нужен username',
  failed: 'ошибка',
};
