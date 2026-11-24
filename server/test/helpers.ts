import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { logger } from '../src/util/logger.js';
import { Links } from '../src/services/links.js';
import { CaptchaService } from '../src/services/captcha.js';
import { NoopTreasury } from '../src/treasury/index.js';
import { MockProvider } from '../src/fulfillment/provider.js';
import type { AppContext, TgApi } from '../src/context.js';
import type { TonCenter } from '../src/ton/toncenter.js';
import { signInitData } from '../src/tg/initData.js';

export const BOT_TOKEN = '123456:TEST-TOKEN';
export const CHANNEL_ID = -1001234567890;
export const BOT_ID = 999;

export class FakeTg {
  sent: { chatId: number | string; text: string; opts: Record<string, unknown> | undefined }[] = [];
  edits: { chatId: number | string; messageId: number; markup: unknown }[] = [];
  /** статус участника канала по user id; по умолчанию member */
  members = new Map<number, string>();
  usernames = new Map<number, string | undefined>();
  private nextId = 100;

  sendMessage = (async (chatId: number | string, text: string, opts?: Record<string, unknown>) => {
    this.sent.push({ chatId, text, opts });
    return { message_id: this.nextId++, date: 0, chat: { id: Number(chatId), type: 'private' } };
  });
  editMessageReplyMarkup = (async (chatId: number | string, messageId: number, other?: { reply_markup?: unknown }) => {
    this.edits.push({ chatId, messageId, markup: other?.reply_markup });
    return true;
  });
  getChatMember = (async (_chatId: number | string, userId: number) => {
    if (userId === BOT_ID) return { status: 'administrator', can_post_messages: true, can_edit_messages: true, user: { id: userId } };
    return { status: this.members.get(userId) ?? 'member', user: { id: userId } };
  });
  getChat = (async (chatId: number | string) => {
    if (typeof chatId === 'string') return { id: CHANNEL_ID, type: 'channel', title: 'Test Channel', username: chatId.replace('@', '') };
    return { id: chatId, type: 'private', username: this.usernames.get(Number(chatId)) };
  });
  getMe = (async () => ({ id: BOT_ID, is_bot: true, first_name: 'Bot', username: 'test_bot' }));
  setChatMenuButton = (async () => true);

  channelPosts() {
    return this.sent.filter((s) => s.chatId === CHANNEL_ID);
  }
}

export interface TestEnv {
  ctx: AppContext;
  tg: FakeTg;
  provider: MockProvider;
  clock: { t: number; advance(ms: number): void };
  initData(user: { id: number; username?: string; first_name?: string }, startParam?: string): string;
}

export function makeEnv(env: Record<string, string> = {}): TestEnv {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    BOT_TOKEN,
    APP_SECRET: 'test-secret',
    TON_USD_RATE_OVERRIDE: '5',
    CAPTCHA_MIN_SOLVE_MS: '1000',
    PUBLIC_URL: 'https://app.example.com',
    WEBAPP_DIST: '/nonexistent',
    ADMIN_IDS: '1',
    ...env,
  } as NodeJS.ProcessEnv);
  const repo = new Repo(openDb(':memory:'));
  const clock = {
    t: Date.parse('2026-12-01T12:00:00Z'),
    advance(ms: number) {
      this.t += ms;
    },
  };
  const tg = new FakeTg();
  const provider = new MockProvider();
  const toncenter = {
    incoming: (async () => []),
    masterchainHead: (async () => ({ seqno: 42, rootHash: 'AbCdEf0123456789' })),
    jettonBalance: (async () => 0n),
  } as unknown as TonCenter;
  const now = () => clock.t;
  const ctx: AppContext = {
    cfg,
    repo,
    tg: tg as unknown as TgApi,
    log: logger,
    now,
    rates: { tonUsd: async () => 5 },
    links: new Links(cfg, 'test_bot'),
    captcha: new CaptchaService(repo, { secret: cfg.APP_SECRET, ttlSec: cfg.CAPTCHA_TTL_SEC, minSolveMs: cfg.CAPTCHA_MIN_SOLVE_MS }),
    toncenter,
    wallet: null,
    receiveAddress: 'UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG',
    treasury: new NoopTreasury(),
    provider,
  };
  return {
    ctx,
    tg,
    provider,
    clock,
    initData(user, startParam) {
      const fields: Record<string, string> = {
        auth_date: String(Math.floor(clock.t / 1000)),
        query_id: 'AAA',
        user: JSON.stringify({ first_name: 'User', ...user, allows_write_to_pm: true }),
      };
      if (startParam) fields.start_param = startParam;
      return signInitData(fields, BOT_TOKEN);
    },
  };
}

export function baseInput(over: Record<string, unknown> = {}) {
  const now = Date.parse('2026-12-01T12:00:00Z');
  return {
    prizeType: 'stars',
    prizeAmount: 100,
    winnersCount: 2,
    startsAt: null,
    endsAt: now + 2 * 86_400_000,
    countries: null,
    captcha: true,
    honeypot: true,
    requireSubscription: true,
    publishResults: true,
    showCounter: true,
    buttonText: 'Участвовать',
    postText: '<b>Большой розыгрыш!</b>',
    channelId: CHANNEL_ID,
    timezone: 'Europe/Moscow',
    ...over,
  };
}
