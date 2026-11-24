import { webhookCallback } from 'grammy';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { Repo } from './db/repo.js';
import { logger } from './util/logger.js';
import { createBot, registerHandlers } from './bot/index.js';
import { buildServer } from './api/server.js';
import { Links } from './services/links.js';
import { MarketRates } from './services/rates.js';
import { CaptchaService } from './services/captcha.js';
import { TonCenter } from './ton/toncenter.js';
import { ServiceWallet } from './ton/wallet.js';
import { StonfiTreasury } from './treasury/index.js';
import { MockProvider, type PrizeProvider } from './fulfillment/provider.js';
import { FragmentProvider } from './fulfillment/fragment.js';
import { FragmentSession } from './fulfillment/fragmentSession.js';
import { startScheduler } from './services/scheduler.js';
import type { AppContext } from './context.js';

async function main() {
  const cfg = loadConfig();
  const log = logger;
  const repo = new Repo(openDb(cfg.DATABASE_PATH));
  const bot = createBot(cfg.BOT_TOKEN);

  let botUsername = process.env.BOT_USERNAME ?? '';
  if (cfg.BOT_MODE !== 'off') {
    const me = await bot.api.getMe();
    botUsername = me.username ?? "";
    bot.botInfo = me;
  }
  if (!botUsername) throw new Error('BOT_USERNAME обязателен при BOT_MODE=off');

  const testnet = cfg.TON_NETWORK === 'testnet';
  const toncenter = new TonCenter({ base: cfg.TONCENTER_API, apiKey: cfg.TONCENTER_API_KEY, testnet });
  const wallet = cfg.TON_WALLET_MNEMONIC
    ? await ServiceWallet.create({
        mnemonic: cfg.TON_WALLET_MNEMONIC,
        version: cfg.TON_WALLET_VERSION,
        endpoint: `${cfg.TONCENTER_API.replace(/\/$/, '')}/api/v2/jsonRPC`,
        apiKey: cfg.TONCENTER_API_KEY,
        testnet,
        log,
      })
    : null;
  const receiveAddress = cfg.TON_RECEIVE_ADDRESS ?? wallet?.address ?? null;
  if (!receiveAddress) log.warn('Не задан ни TON_WALLET_MNEMONIC, ни TON_RECEIVE_ADDRESS — приём оплаты отключён');

  const now = () => Date.now();
  const treasury = new StonfiTreasury({
    mode: cfg.TREASURY_MODE,
    dryRun: cfg.TREASURY_DRY_RUN,
    gasReserveTon: cfg.TREASURY_GAS_RESERVE_TON,
    slippage: cfg.TREASURY_SLIPPAGE,
    usdtMaster: cfg.USDT_JETTON_MASTER,
    tonAddress: cfg.STONFI_TON_ADDRESS,
    repo,
    log,
    toncenter,
    wallet,
    now,
  });

  let provider: PrizeProvider;
  let fragment: FragmentSession | null = null;
  if (cfg.FULFILLMENT_PROVIDER === 'fragment') {
    // кошелёк нужен даже в dry-run: им выполняется вход на Fragment (ton_proof)
    if (!wallet) throw new Error('Выдача через Fragment требует TON_WALLET_MNEMONIC');
    fragment = new FragmentSession({ repo, wallet, log, seedCookies: cfg.FRAGMENT_COOKIES });
    provider = new FragmentProvider({ session: fragment, wallet, treasury, dryRun: cfg.FULFILLMENT_DRY_RUN, log });
    if (!fragment.state.telegram) log.warn('Fragment: нет входа Telegram — отправьте боту /fragment (из аккаунта админа)');
  } else {
    if (cfg.NODE_ENV === 'production') log.warn('FULFILLMENT_PROVIDER=mock в продакшене — призы НЕ выдаются!');
    provider = new MockProvider();
  }

  const ctx: AppContext = {
    cfg,
    repo,
    tg: bot.api,
    log,
    now,
    rates: new MarketRates({ override: cfg.TON_USD_RATE_OVERRIDE, log }),
    links: new Links(cfg, botUsername),
    captcha: new CaptchaService(repo, { secret: cfg.APP_SECRET, ttlSec: cfg.CAPTCHA_TTL_SEC, minSolveMs: cfg.CAPTCHA_MIN_SOLVE_MS }),
    toncenter,
    wallet,
    receiveAddress,
    treasury,
    provider,
    fragment,
  };

  registerHandlers(bot, ctx);

  const webhookPath = `/tg/webhook`;
  const server = await buildServer(ctx, {
    logger: false,
    webhook:
      cfg.BOT_MODE === 'webhook'
        ? { path: webhookPath, handler: webhookCallback(bot, 'fastify', { secretToken: cfg.WEBHOOK_SECRET }) as never }
        : undefined,
  });
  await server.listen({ port: cfg.PORT, host: cfg.HOST });
  log.info({ port: cfg.PORT, bot: botUsername, receiveAddress }, 'server started');

  if (cfg.BOT_MODE !== 'off') {
    await bot.api
      .setChatMenuButton({ menu_button: { type: 'web_app', text: 'Розыгрыши', web_app: { url: ctx.links.webApp('/') } } })
      .catch((e) => log.warn({ err: String(e) }, 'setChatMenuButton failed (нужен HTTPS PUBLIC_URL)'));
    const allowed = ['message', 'callback_query', 'my_chat_member'] as const;
    if (cfg.BOT_MODE === 'webhook') {
      if (!cfg.WEBHOOK_SECRET) throw new Error('BOT_MODE=webhook требует WEBHOOK_SECRET');
      await bot.api.setWebhook(`${cfg.PUBLIC_URL.replace(/\/$/, '')}${webhookPath}`, { secret_token: cfg.WEBHOOK_SECRET, allowed_updates: [...allowed] });
    } else {
      await bot.api.deleteWebhook();
      void bot.start({ allowed_updates: [...allowed], onStart: () => log.info('bot polling started') });
    }
  }

  const scheduler = startScheduler(ctx);

  const shutdown = async () => {
    log.info('shutting down');
    scheduler.stop();
    await bot.stop().catch(() => undefined);
    await server.close();
    repo.db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.fatal({ err: String(e?.stack ?? e) }, 'fatal');
  process.exit(1);
});
