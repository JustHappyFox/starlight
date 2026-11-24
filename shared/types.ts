// Общие типы API между сервером и мини-аппом.
// Все времена — миллисекунды Unix (Date.now()).

export type PrizeType = 'stars' | 'premium';

export type GiveawayStatus =
  | 'draft' // создан, не оплачен
  | 'scheduled' // оплачен, ждёт времени публикации
  | 'active' // опубликован, идёт приём участников
  | 'drawing' // идёт подведение итогов
  | 'finished' // итоги подведены
  | 'cancelled'; // черновик отменён

export type WinnerPrizeStatus = 'pending' | 'processing' | 'sent' | 'needs_username' | 'failed';

export interface PriceQuote {
  prizeType: PrizeType;
  prizeAmount: number;
  winnersCount: number;
  /** Цена одного приза по прайсу Telegram, USD */
  unitPriceUsd: number;
  totalUsd: number;
  tonUsdRate: number;
  /** Сумма к оплате в TON, десятичная строка */
  totalTon: string;
  totalNano: string;
}

export interface GiveawayInput {
  prizeType: PrizeType;
  /** Stars: количество звёзд на одного победителя. Premium: число месяцев (3/6/12). */
  prizeAmount: number;
  winnersCount: number;
  /** null — сразу после оплаты */
  startsAt: number | null;
  endsAt: number;
  /** ISO-3166 alpha-2, null — все страны */
  countries: string[] | null;
  captcha: boolean;
  honeypot: boolean;
  requireSubscription: boolean;
  publishResults: boolean;
  showCounter: boolean;
  buttonText: string;
  postText: string;
  channelId: number | null;
  timezone: string;
}

export interface ChannelView {
  id: number;
  title: string;
  username: string | null;
  botCanPost: boolean;
}

export interface InvoiceView {
  id: string;
  address: string;
  amountNano: string;
  amountTon: string;
  paidNano: string;
  comment: string;
  /** base64 BOC с текстовым комментарием — для TON Connect */
  payload: string;
  tonLink: string;
  expiresAt: number;
  status: 'pending' | 'paid' | 'expired' | 'underpaid';
}

export interface WinnerView {
  place: number;
  name: string;
  username: string | null;
  prizeStatus: WinnerPrizeStatus;
}

export interface GiveawayOwnerView extends GiveawayInput {
  id: string;
  status: GiveawayStatus;
  participantsCount: number;
  priceUsd: number;
  channel: ChannelView | null;
  invoice: InvoiceView | null;
  postUrl: string | null;
  appLink: string;
  seedHash: string;
  lastError: string | null;
  createdAt: number;
  paidAt: number | null;
  publishedAt: number | null;
  drawnAt: number | null;
  winners: WinnerView[];
}

export type Phase = 'upcoming' | 'active' | 'drawing' | 'finished' | 'cancelled' | 'unpaid';

export interface PublicGiveawayView {
  id: string;
  phase: Phase;
  prizeType: PrizeType;
  prizeAmount: number;
  winnersCount: number;
  startsAt: number | null;
  endsAt: number;
  countries: string[] | null;
  captcha: boolean;
  requireSubscription: boolean;
  channel: { title: string; username: string | null; url: string | null };
  participantsCount: number;
  seedHash: string;
  me: {
    joined: boolean;
    tickets: number;
    referrals: number;
    refLink: string | null;
    hasUsername: boolean;
    phoneCountry: string | null;
    countryOk: boolean;
    isWinner: boolean;
  };
  results: {
    drawnAt: number;
    winners: WinnerView[];
    proofAvailable: boolean;
  } | null;
}

export interface MeView {
  id: number;
  firstName: string;
  username: string | null;
  phoneCountry: string | null;
  isAdmin: boolean;
  channels: ChannelView[];
  connectChannelLink: string;
  botUsername: string;
}

export interface AppConfigView {
  botUsername: string;
  /** Ссылка на мини-апп — сюда кошелёк возвращает пользователя после оплаты */
  appLink: string;
  limits: {
    minStars: number;
    maxStars: number;
    starsPresets: number[];
    premiumMonths: number[];
    maxWinners: number;
    maxDurationDays: number;
    minDurationMinutes: number;
    buttonTextMax: number;
    postTextMax: number;
  };
  buttonPresets: string[];
  refTicketCap: number;
  tonConnectManifestUrl: string;
  devMode: boolean;
}

export interface CaptchaChallenge {
  challengeId: string;
  image: string; // data:image/png;base64,...
  expiresAt: number;
}

export interface JoinRequest {
  challengeId?: string;
  answer?: string;
  ref?: string;
  /** Скрытое поле-ловушка: человек его не видит и не заполняет */
  website?: string;
  signals?: { openedAt?: number; interactions?: number; webdriver?: boolean };
}

export type ApiErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'forbidden'
  | 'bad_request'
  | 'not_active'
  | 'banned'
  | 'need_username'
  | 'need_phone'
  | 'country_not_allowed'
  | 'need_subscription'
  | 'captcha_required'
  | 'captcha_wrong'
  | 'captcha_expired'
  | 'too_fast'
  | 'rate_limited'
  | 'channel_not_ready'
  | 'not_paid'
  | 'locked'
  | 'internal';

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

/** Данные для независимой проверки розыгрыша */
export interface DrawProof {
  version: 1;
  giveawayId: string;
  seed: string;
  seedHash: string;
  entropy: { source: string; value: string };
  participantsHash: string;
  /** Отсортировано по псевдониму. Псевдоним = sha256(giveawayId:userId)[0..16] */
  entries: { p: string; t: number }[];
  /** Порядок проверки: на шаге i выбран participant; disqualified — снят и не считается */
  steps: { step: number; p: string; result: 'win' | 'disqualified'; reason?: string }[];
  winnersCount: number;
}
