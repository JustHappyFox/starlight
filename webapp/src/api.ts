import { tg } from './tg';
import type { ApiErrorCode } from '../../shared/types';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

/** Origin бэкенда: совпадает с мини-аппом или задан VITE_API_BASE (фронт на Netlify) */
export const apiOrigin = () => BASE || location.origin;

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        authorization: `tma ${tg.initData}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('internal', 'Нет связи с сервером. Проверьте интернет.', 0);
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: ApiErrorCode; message: string } } | null;
  if (!res.ok) throw new ApiError(data?.error?.code ?? 'internal', data?.error?.message ?? `Ошибка ${res.status}`, res.status);
  return data as T;
}

export const get = <T>(p: string) => api<T>('GET', p);
export const post = <T>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const put = <T>(p: string, b: unknown) => api<T>('PUT', p, b);
export const del = <T>(p: string) => api<T>('DELETE', p);
