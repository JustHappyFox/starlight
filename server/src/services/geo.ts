import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** Страна по номеру телефона. Анонимные номера Fragment (+888) страны не имеют → null. */
export function countryFromPhone(phone: string): string | null {
  const normalized = phone.startsWith('+') ? phone : `+${phone}`;
  const parsed = parsePhoneNumberFromString(normalized);
  return parsed?.country ?? null;
}

export function isCountryAllowed(allowed: string[] | null, country: string | null): boolean {
  if (!allowed || allowed.length === 0) return true;
  return !!country && allowed.includes(country.toUpperCase());
}

export function normalizeCountries(list: unknown): string[] | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const set = new Set<string>();
  for (const c of list) if (typeof c === 'string' && /^[A-Za-z]{2}$/.test(c)) set.add(c.toUpperCase());
  return set.size ? [...set].sort() : null;
}
