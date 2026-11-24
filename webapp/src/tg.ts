// Обёртка над Telegram.WebApp. Вне Telegram (dev) — минимальная заглушка,
// initData берётся из #tgWebAppData=... или из /api/dev/initdata.

interface BottomButton {
  setText(t: string): void;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  setParams?(p: Record<string, unknown>): void;
  isVisible: boolean;
}

export interface WebApp {
  initData: string;
  initDataUnsafe: { user?: { id: number; first_name: string; username?: string; allows_write_to_pm?: boolean }; start_param?: string };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  isVersionAtLeast(v: string): boolean;
  MainButton: BottomButton;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: { notificationOccurred(t: 'error' | 'success' | 'warning'): void; impactOccurred(s: 'light' | 'medium'): void };
  showAlert(msg: string, cb?: () => void): void;
  showPopup(p: { title?: string; message: string; buttons?: { id?: string; type?: string; text?: string }[] }, cb?: (id: string) => void): void;
  showConfirm(msg: string, cb: (ok: boolean) => void): void;
  openTelegramLink(url: string): void;
  openLink(url: string): void;
  requestContact(cb?: (ok: boolean, res?: { status?: string; response?: string; responseUnsafe?: unknown }) => void): void;
  requestWriteAccess(cb?: (ok: boolean) => void): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  setHeaderColor?(c: string): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: WebApp };
  }
}

const real = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;
/** true — мы внутри настоящего клиента Telegram */
export const inTelegram = !!real && !!real.initData;

function shim(): WebApp {
  const hash = new URLSearchParams(location.hash.slice(1));
  const initData = hash.get('tgWebAppData') ?? sessionStorageGet('devInitData') ?? '';
  const params = new URLSearchParams(initData);
  let user;
  try {
    user = JSON.parse(params.get('user') ?? 'null') ?? undefined;
  } catch {
    user = undefined;
  }
  const noop = () => {};
  return {
    initData,
    initDataUnsafe: { user, start_param: params.get('start_param') ?? undefined },
    version: '7.0',
    platform: 'web',
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    ready: noop,
    expand: noop,
    isVersionAtLeast: () => true,
    // в заглушке нижняя кнопка рисуется в DOM (см. ui.tsx)
    MainButton: { setText: noop, show: noop, hide: noop, enable: noop, disable: noop, showProgress: noop, hideProgress: noop, onClick: noop, offClick: noop, isVisible: false },
    BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
    showAlert: (m, cb) => {
      alert(m);
      cb?.();
    },
    showPopup: (p, cb) => {
      alert((p.title ? p.title + '\n\n' : '') + p.message);
      cb?.('ok');
    },
    showConfirm: (m, cb) => cb(confirm(m)),
    openTelegramLink: (u) => window.open(u, '_blank'),
    openLink: (u) => window.open(u, '_blank'),
    requestContact: (cb) => cb?.(false),
    requestWriteAccess: (cb) => cb?.(true),
  };
}

function sessionStorageGet(k: string): string | null {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}

export const tg: WebApp = inTelegram ? real! : shim();

export function setDevInitData(v: string) {
  try {
    sessionStorage.setItem('devInitData', v);
  } catch {
    /* ignore */
  }
  (tg as { initData: string }).initData = v;
  const params = new URLSearchParams(v);
  try {
    tg.initDataUnsafe.user = JSON.parse(params.get('user') ?? 'null') ?? undefined;
  } catch {
    /* ignore */
  }
  tg.initDataUnsafe.start_param = params.get('start_param') ?? tg.initDataUnsafe.start_param;
}

export function haptic(kind: 'success' | 'error' | 'warning' | 'light') {
  try {
    if (kind === 'light') tg.HapticFeedback?.impactOccurred('light');
    else tg.HapticFeedback?.notificationOccurred(kind);
  } catch {
    /* ignore */
  }
}

export function alertMsg(message: string, title?: string): Promise<void> {
  return new Promise((resolve) => {
    if (inTelegram && tg.isVersionAtLeast('6.2')) tg.showPopup({ title, message, buttons: [{ type: 'close' }] }, () => resolve());
    else tg.showAlert(title ? `${title}\n\n${message}` : message, () => resolve());
  });
}

export function confirmMsg(message: string): Promise<boolean> {
  return new Promise((resolve) => tg.showConfirm(message, resolve));
}

export function shareLink(url: string, text: string) {
  tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
