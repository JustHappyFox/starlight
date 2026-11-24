import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TgWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  allows_write_to_pm?: boolean;
  photo_url?: string;
}

export interface ValidatedInitData {
  user: TgWebAppUser;
  authDate: number; // секунды
  startParam: string | null;
  queryId: string | null;
  chatType: string | null;
  raw: Record<string, string>;
}

export class InitDataError extends Error {}

function secretKey(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest();
}

/**
 * Проверка подписи строки в формате initData (используется и для ответа requestContact).
 * В data-check-string входят ВСЕ поля, кроме `hash` (поле `signature` тоже входит!).
 */
export function verifySignedQuery(raw: string, botToken: string): Record<string, string> {
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new InitDataError('hash отсутствует');
  const pairs: string[] = [];
  const out: Record<string, string> = {};
  for (const [k, v] of params) {
    if (k === 'hash') continue;
    pairs.push(`${k}=${v}`);
    out[k] = v;
  }
  pairs.sort();
  const calc = createHmac('sha256', secretKey(botToken)).update(pairs.join('\n')).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== calc.length || !timingSafeEqual(given, calc)) throw new InitDataError('подпись не совпадает');
  return out;
}

export function validateInitData(raw: string, botToken: string, maxAgeSec: number, nowMs = Date.now()): ValidatedInitData {
  const fields = verifySignedQuery(raw, botToken);
  const authDate = Number(fields.auth_date);
  if (!Number.isFinite(authDate) || authDate <= 0) throw new InitDataError('auth_date некорректен');
  const ageSec = nowMs / 1000 - authDate;
  if (ageSec > maxAgeSec) throw new InitDataError('initData устарела — перезапустите мини-апп');
  if (ageSec < -300) throw new InitDataError('auth_date из будущего');
  if (!fields.user) throw new InitDataError('нет user');
  let user: TgWebAppUser;
  try {
    user = JSON.parse(fields.user) as TgWebAppUser;
  } catch {
    throw new InitDataError('user не JSON');
  }
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new InitDataError('user.id некорректен');
  return {
    user,
    authDate,
    startParam: fields.start_param ?? null,
    queryId: fields.query_id ?? null,
    chatType: fields.chat_type ?? null,
    raw: fields,
  };
}

/** Для тестов и dev-режима: подписать initData токеном бота. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const hash = createHmac('sha256', secretKey(botToken)).update(pairs.join('\n')).digest('hex');
  const p = new URLSearchParams(fields);
  p.set('hash', hash);
  return p.toString();
}
