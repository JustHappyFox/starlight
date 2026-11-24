import type { Config } from '../config.js';

export class Links {
  constructor(
    private cfg: Pick<Config, 'MINIAPP_SHORT_NAME' | 'PUBLIC_URL'>,
    public botUsername: string,
  ) {}

  /** Прямая ссылка на мини-апп с параметром (работает из каналов, в отличие от web_app-кнопок) */
  app(startParam?: string): string {
    const base = this.cfg.MINIAPP_SHORT_NAME
      ? `https://t.me/${this.botUsername}/${this.cfg.MINIAPP_SHORT_NAME}`
      : `https://t.me/${this.botUsername}`;
    return startParam ? `${base}?startapp=${encodeURIComponent(startParam)}` : this.cfg.MINIAPP_SHORT_NAME ? base : `${base}?startapp`;
  }

  giveaway(gid: string, refCode?: string): string {
    return this.app(refCode ? `${gid}_${refCode}` : gid);
  }

  /** Добавить бота админом в канал с нужными правами */
  connectChannel(): string {
    return `https://t.me/${this.botUsername}?startchannel&admin=post_messages+edit_messages`;
  }

  /** URL веб-приложения для web_app-кнопок в личке с ботом */
  webApp(route = ''): string {
    return `${this.cfg.PUBLIC_URL.replace(/\/$/, '')}/${route ? '#' + route : ''}`;
  }

  channelPost(channel: { id: number; username: string | null }, messageId: number): string {
    if (channel.username) return `https://t.me/${channel.username}/${messageId}`;
    const internal = String(channel.id).replace(/^-100/, '');
    return `https://t.me/c/${internal}/${messageId}`;
  }

  channel(channel: { id: number; username: string | null }): string | null {
    return channel.username ? `https://t.me/${channel.username}` : null;
  }
}

/** startapp-параметр: "<gid>" или "<gid>_<ref>" */
export function parseStartParam(p: string | null | undefined): { gid: string; ref: string | null } | null {
  if (!p) return null;
  const m = /^([A-Za-z0-9]{6,16})(?:_([A-Za-z0-9]{4,16}))?$/.exec(p);
  if (!m) return null;
  return { gid: m[1]!, ref: m[2] ?? null };
}
