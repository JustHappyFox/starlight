import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

const ALNUM = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomId(len = 10, alphabet = ALNUM): string {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export const hmacHex = (key: string, s: string): string => createHmac('sha256', key).update(s).digest('hex');

export const randomSeed = (): string => randomBytes(32).toString('hex');
