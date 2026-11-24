import type { Api } from 'grammy';
import type { Config } from './config.js';
import type { Repo } from './db/repo.js';
import type { Logger } from './util/logger.js';
import type { RateProvider } from './services/rates.js';
import type { Links } from './services/links.js';
import type { CaptchaService } from './services/captcha.js';
import type { TonCenter } from './ton/toncenter.js';
import type { WalletLike } from './ton/wallet.js';
import type { Treasury } from './treasury/index.js';
import type { PrizeProvider } from './fulfillment/provider.js';
import type { FragmentSession } from './fulfillment/fragmentSession.js';

/** Подмножество Bot API, которым пользуется приложение (в тестах подменяется фейком) */
export type TgApi = Pick<
  Api,
  'sendMessage' | 'editMessageReplyMarkup' | 'getChatMember' | 'getChat' | 'getMe' | 'setChatMenuButton'
>;

export interface AppContext {
  cfg: Config;
  repo: Repo;
  tg: TgApi;
  log: Logger;
  now: () => number;
  rates: RateProvider;
  links: Links;
  captcha: CaptchaService;
  toncenter: TonCenter;
  wallet: WalletLike | null;
  /** Адрес приёма оплаты */
  receiveAddress: string | null;
  treasury: Treasury;
  provider: PrizeProvider;
  /** Сессия fragment.com (только при FULFILLMENT_PROVIDER=fragment) */
  fragment: FragmentSession | null;
}
