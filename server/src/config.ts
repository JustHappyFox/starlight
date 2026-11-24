import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

const list = (def: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: num(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Публичный HTTPS-адрес мини-аппа (тот же, что указан в BotFather) */
  PUBLIC_URL: z.string().default('http://localhost:3000'),
  /** Если фронт хостится отдельно (Netlify) — его origin для CORS */
  WEBAPP_ORIGIN: z.string().optional(),
  DATABASE_PATH: z.string().default('./data/starlight.db'),
  WEBAPP_DIST: z.string().default('../webapp/dist'),

  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN обязателен'),
  BOT_MODE: z.enum(['polling', 'webhook', 'off']).default('polling'),
  WEBHOOK_SECRET: z.string().optional(),
  /** Короткое имя мини-аппа из BotFather (/newapp). Пусто — используется main mini app бота */
  MINIAPP_SHORT_NAME: z.string().optional(),
  ADMIN_IDS: list().transform((a) => a.map(Number).filter(Number.isFinite)),
  INIT_DATA_MAX_AGE_SEC: num(86400),

  /** Секрет для HMAC ответов капчи и прочего. Обязателен в проде */
  APP_SECRET: z.string().default('dev-secret-change-me'),
  DEV_MODE: bool(false),

  // --- TON ---
  TON_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
  TONCENTER_API: z.string().default('https://toncenter.com'),
  TONCENTER_API_KEY: z.string().optional(),
  /** Мнемоника сервисного кошелька (24 слова). Без неё платежи принимаются только на TON_RECEIVE_ADDRESS, а выдача призов невозможна */
  TON_WALLET_MNEMONIC: z.string().optional(),
  TON_WALLET_VERSION: z.enum(['v4', 'v5r1']).default('v5r1'),
  /** Адрес для приёма оплаты. По умолчанию — адрес кошелька из мнемоники */
  TON_RECEIVE_ADDRESS: z.string().optional(),
  INVOICE_TTL_MIN: num(20),
  /** Запас на колебание курса при выставлении счёта, доля (0.01 = 1%) */
  RATE_BUFFER: num(0.01),
  TON_USD_RATE_OVERRIDE: num(0),
  PAYMENT_POLL_SEC: num(15),

  // --- Казначейство (TON -> USDT -> TON) ---
  TREASURY_MODE: z.enum(['ton', 'usdt']).default('ton'),
  TREASURY_DRY_RUN: bool(true),
  /** Сколько TON всегда держать на кошельке под газ */
  TREASURY_GAS_RESERVE_TON: num(1.5),
  TREASURY_SLIPPAGE: num(0.01),
  USDT_JETTON_MASTER: z.string().default('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'),
  STONFI_TON_ADDRESS: z.string().default('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'),

  // --- Выдача призов ---
  FULFILLMENT_PROVIDER: z.enum(['mock', 'fragment']).default('mock'),
  FRAGMENT_COOKIES: z.string().optional(),
  FRAGMENT_HASH: z.string().optional(),
  FULFILLMENT_DRY_RUN: bool(true),
  FULFILLMENT_MAX_ATTEMPTS: num(8),
  CLAIM_WINDOW_DAYS: num(7),

  // --- Цены (USD). Проверьте актуальные! ---
  /** Цена 1 звезды в приложении Telegram */
  TG_STAR_PRICE_USD: num(0.0199),
  /** Цены подарка Premium в приложении Telegram, через запятую: 3,6,12 мес */
  TG_PREMIUM_PRICES_USD: list(['13.99', '18.99', '34.99']).transform((a) => a.map(Number)),
  /** Ожидаемая себестоимость на Fragment — только для отчётов о марже */
  FRAGMENT_STAR_PRICE_USD: num(0.015),
  FRAGMENT_PREMIUM_PRICES_USD: list(['11.99', '15.99', '28.99']).transform((a) => a.map(Number)),

  // --- Лимиты ---
  MIN_STARS: num(50),
  MAX_STARS: num(100000),
  MAX_WINNERS: num(200),
  MAX_DURATION_DAYS: num(60),
  MIN_DURATION_MINUTES: num(10),
  REF_TICKET_CAP: num(100),
  CAPTCHA_TTL_SEC: num(180),
  CAPTCHA_MIN_SOLVE_MS: num(1500),
  HONEYPOT_GLOBAL_BAN_HITS: num(3),
  BUTTON_UPDATE_INTERVAL_SEC: num(60),
  SCHEDULER_TICK_SEC: num(10),
  /** off | log | enforce — проверка страны по заголовку CF-IPCountry (если стоите за Cloudflare) */
  GEO_IP_MODE: z.enum(['off', 'log', 'enforce']).default('off'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Ошибка конфигурации:\n${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    if (cfg.APP_SECRET === 'dev-secret-change-me') throw new Error('APP_SECRET нужно задать в продакшене');
    if (cfg.DEV_MODE) throw new Error('DEV_MODE запрещён в продакшене');
  }
  if (cfg.TG_PREMIUM_PRICES_USD.length !== 3 || cfg.FRAGMENT_PREMIUM_PRICES_USD.length !== 3) {
    throw new Error('Цены Premium задаются тремя числами: 3,6,12 месяцев');
  }
  return cfg;
}

export const PREMIUM_MONTHS = [3, 6, 12] as const;
export const STARS_PRESETS = [50, 100, 250, 500, 1000, 2500];
export const BUTTON_PRESETS = ['Участвовать', '🎁 Участвую!', '🍀 Испытать удачу', '⭐ Хочу приз'];
export const BUTTON_TEXT_MAX = 32;
export const POST_TEXT_MAX = 3000;
