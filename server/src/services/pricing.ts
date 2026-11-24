import type { Config } from '../config.js';
import { PREMIUM_MONTHS } from '../config.js';
import type { PriceQuote, PrizeType } from '../../../shared/types.js';

export type PricingConfig = Pick<
  Config,
  'TG_STAR_PRICE_USD' | 'TG_PREMIUM_PRICES_USD' | 'FRAGMENT_STAR_PRICE_USD' | 'FRAGMENT_PREMIUM_PRICES_USD' | 'RATE_BUFFER' | 'MIN_STARS' | 'MAX_STARS'
>;

export class PricingError extends Error {}

export function validatePrize(cfg: PricingConfig, type: PrizeType, amount: number) {
  if (type === 'stars') {
    if (!Number.isInteger(amount) || amount < cfg.MIN_STARS || amount > cfg.MAX_STARS)
      throw new PricingError(`Звёзд на победителя: от ${cfg.MIN_STARS} до ${cfg.MAX_STARS}`);
  } else if (type === 'premium') {
    if (!(PREMIUM_MONTHS as readonly number[]).includes(amount)) throw new PricingError('Premium: 3, 6 или 12 месяцев');
  } else {
    throw new PricingError('Неизвестный тип приза');
  }
}

/** ceil без float-шума: 100 * 0.0199 * 100 = 199.00000000000003 → должно быть 199 */
function ceilCents(x: number): number {
  return Math.ceil(Math.round(x * 1e6) / 1e6);
}

/** Цена одного приза для заказчика (прайс Telegram), центы */
export function unitPriceCents(cfg: PricingConfig, type: PrizeType, amount: number): number {
  validatePrize(cfg, type, amount);
  if (type === 'stars') return ceilCents(amount * cfg.TG_STAR_PRICE_USD * 100);
  return Math.round(cfg.TG_PREMIUM_PRICES_USD[PREMIUM_MONTHS.indexOf(amount as 3 | 6 | 12)]! * 100);
}

/** Ожидаемая себестоимость на Fragment, центы (для отчёта о марже) */
export function unitCostCents(cfg: PricingConfig, type: PrizeType, amount: number): number {
  if (type === 'stars') return ceilCents(amount * cfg.FRAGMENT_STAR_PRICE_USD * 100);
  return Math.round(cfg.FRAGMENT_PREMIUM_PRICES_USD[PREMIUM_MONTHS.indexOf(amount as 3 | 6 | 12)]! * 100);
}

const NANO = 1_000_000_000n;
const STEP = 1_000_000n; // округляем вверх до 0.001 TON

export function usdCentsToNano(cents: number, tonUsdRate: number, buffer: number): bigint {
  if (!(tonUsdRate > 0)) throw new PricingError('Курс TON недоступен');
  // считаем в микро-долларах, чтобы не терять точность
  const microUsd = BigInt(Math.round(cents * 10_000 * (1 + buffer)));
  const rateMicro = BigInt(Math.round(tonUsdRate * 1_000_000));
  let nano = (microUsd * NANO + rateMicro - 1n) / rateMicro; // ceil
  nano = ((nano + STEP - 1n) / STEP) * STEP;
  return nano;
}

export function formatTon(nano: bigint | string): string {
  const n = BigInt(nano);
  const whole = n / NANO;
  const frac = (n % NANO).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function quote(cfg: PricingConfig, type: PrizeType, amount: number, winners: number, tonUsdRate: number): PriceQuote & { totalCents: number; costCents: number } {
  const unit = unitPriceCents(cfg, type, amount);
  const totalCents = unit * winners;
  const nano = usdCentsToNano(totalCents, tonUsdRate, cfg.RATE_BUFFER);
  return {
    prizeType: type,
    prizeAmount: amount,
    winnersCount: winners,
    unitPriceUsd: unit / 100,
    totalUsd: totalCents / 100,
    tonUsdRate,
    totalTon: formatTon(nano),
    totalNano: nano.toString(),
    totalCents,
    costCents: unitCostCents(cfg, type, amount) * winners,
  };
}
