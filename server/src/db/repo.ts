import type { DB } from './index.js';
import type { GiveawayStatus, PrizeType, WinnerPrizeStatus } from '../../../shared/types.js';

export interface UserRow {
  id: number;
  username: string | null;
  first_name: string;
  last_name: string | null;
  language_code: string | null;
  is_premium: number;
  allows_pm: number;
  phone_country: string | null;
  phone_verified_at: number | null;
  honeypot_hits: number;
  global_ban: number;
  created_at: number;
  updated_at: number;
}

export interface ChannelRow {
  id: number;
  title: string;
  username: string | null;
  bot_can_post: number;
  bot_can_edit: number;
  active: number;
  created_at: number;
  updated_at: number;
}

export interface GiveawayRow {
  id: string;
  creator_id: number;
  channel_id: number | null;
  status: GiveawayStatus;
  prize_type: PrizeType;
  prize_amount: number;
  winners_count: number;
  starts_at: number | null;
  ends_at: number;
  timezone: string;
  countries: string | null;
  captcha: number;
  honeypot: number;
  require_subscription: number;
  publish_results: number;
  show_counter: number;
  button_text: string;
  post_text: string;
  price_usd_cents: number;
  cost_estimate_usd_cents: number;
  seed: string;
  seed_hash: string;
  post_message_id: number | null;
  results_message_id: number | null;
  participants_count: number;
  button_count: number;
  button_phase: string | null;
  button_updated_at: number;
  proof: string | null;
  last_error: string | null;
  paid_at: number | null;
  published_at: number | null;
  drawn_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface InvoiceRow {
  id: string;
  giveaway_id: string;
  comment: string;
  amount_nano: string;
  paid_nano: string;
  amount_usd_cents: number;
  ton_usd_rate: number;
  status: 'pending' | 'paid' | 'expired' | 'underpaid';
  created_at: number;
  expires_at: number;
  paid_at: number | null;
}

export interface ParticipantRow {
  giveaway_id: string;
  user_id: number;
  ref_code: string;
  referrer_id: number | null;
  status: 'active' | 'banned';
  country: string | null;
  ip_country: string | null;
  risk: number;
  solve_ms: number | null;
  joined_at: number;
}

export interface WinnerRow {
  giveaway_id: string;
  user_id: number;
  place: number;
  status: WinnerPrizeStatus;
  attempts: number;
  next_attempt_at: number;
  username_used: string | null;
  provider_ref: string | null;
  tx_ref: string | null;
  cost_nano: string | null;
  last_error: string | null;
  notified: number;
  /** Username получателя, если победитель указал другой аккаунт */
  recipient: string | null;
  /** Почему приз ждёт действия победителя */
  issue: WinnerIssue | null;
  reminded: number;
  created_at: number;
  updated_at: number;
}

export type WinnerIssue = 'no_username' | 'not_found' | 'ineligible';

export interface CaptchaRow {
  id: string;
  giveaway_id: string;
  user_id: number;
  answer_hash: string;
  created_at: number;
  expires_at: number;
  used: number;
}

export type GiveawayInsert = Omit<
  GiveawayRow,
  | 'post_message_id'
  | 'results_message_id'
  | 'participants_count'
  | 'button_count'
  | 'button_phase'
  | 'button_updated_at'
  | 'proof'
  | 'last_error'
  | 'paid_at'
  | 'published_at'
  | 'drawn_at'
>;

/** Тонкая обёртка над SQLite. Бизнес-логика — в services/. */
export class Repo {
  constructor(readonly db: DB) {}

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------- meta ----------
  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------- users ----------
  upsertUser(u: {
    id: number;
    username?: string | null;
    first_name?: string;
    last_name?: string | null;
    language_code?: string | null;
    is_premium?: boolean;
    allows_pm?: boolean;
  }, now: number) {
    this.db
      .prepare(
        `INSERT INTO users (id, username, first_name, last_name, language_code, is_premium, allows_pm, created_at, updated_at)
         VALUES (@id, @username, @first_name, @last_name, @language_code, @is_premium, @allows_pm, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           first_name = excluded.first_name,
           last_name = excluded.last_name,
           language_code = COALESCE(excluded.language_code, users.language_code),
           is_premium = excluded.is_premium,
           allows_pm = MAX(users.allows_pm, excluded.allows_pm),
           updated_at = excluded.updated_at`,
      )
      .run({
        id: u.id,
        username: u.username ?? null,
        first_name: u.first_name ?? '',
        last_name: u.last_name ?? null,
        language_code: u.language_code ?? null,
        is_premium: u.is_premium ? 1 : 0,
        allows_pm: u.allows_pm ? 1 : 0,
        now,
      });
  }
  getUser(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }
  setAllowsPm(id: number, allows: boolean) {
    this.db.prepare('UPDATE users SET allows_pm = ? WHERE id = ?').run(allows ? 1 : 0, id);
  }
  setPhoneCountry(id: number, country: string | null, now: number) {
    this.db.prepare('UPDATE users SET phone_country = ?, phone_verified_at = ?, updated_at = ? WHERE id = ?').run(country, now, now, id);
  }
  incHoneypotHits(id: number): number {
    this.db.prepare('UPDATE users SET honeypot_hits = honeypot_hits + 1 WHERE id = ?').run(id);
    return this.getUser(id)?.honeypot_hits ?? 0;
  }
  setGlobalBan(id: number, ban: boolean) {
    this.db.prepare('UPDATE users SET global_ban = ? WHERE id = ?').run(ban ? 1 : 0, id);
  }

  // ---------- channels ----------
  upsertChannel(c: { id: number; title: string; username: string | null; bot_can_post: boolean; bot_can_edit: boolean; active: boolean }, now: number) {
    this.db
      .prepare(
        `INSERT INTO channels (id, title, username, bot_can_post, bot_can_edit, active, created_at, updated_at)
         VALUES (@id, @title, @username, @bot_can_post, @bot_can_edit, @active, @now, @now)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, username = excluded.username,
           bot_can_post = excluded.bot_can_post, bot_can_edit = excluded.bot_can_edit,
           active = excluded.active, updated_at = excluded.updated_at`,
      )
      .run({ ...c, bot_can_post: c.bot_can_post ? 1 : 0, bot_can_edit: c.bot_can_edit ? 1 : 0, active: c.active ? 1 : 0, now });
  }
  getChannel(id: number): ChannelRow | undefined {
    return this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
  }
  addChannelManager(channelId: number, userId: number, now: number) {
    this.db.prepare('INSERT OR IGNORE INTO channel_managers (channel_id, user_id, created_at) VALUES (?, ?, ?)').run(channelId, userId, now);
  }
  removeChannelManager(channelId: number, userId: number) {
    this.db.prepare('DELETE FROM channel_managers WHERE channel_id = ? AND user_id = ?').run(channelId, userId);
  }
  isChannelManager(channelId: number, userId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM channel_managers WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
  }
  listUserChannels(userId: number): ChannelRow[] {
    return this.db
      .prepare(
        `SELECT c.* FROM channels c JOIN channel_managers m ON m.channel_id = c.id
         WHERE m.user_id = ? AND c.active = 1 ORDER BY c.title`,
      )
      .all(userId) as ChannelRow[];
  }

  // ---------- giveaways ----------
  insertGiveaway(g: GiveawayInsert) {
    const cols = Object.keys(g);
    this.db.prepare(`INSERT INTO giveaways (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(g);
  }
  updateGiveaway(id: string, patch: Partial<GiveawayRow>, now: number) {
    const entries = Object.entries({ ...patch, updated_at: now });
    const sets = entries.map(([k]) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE giveaways SET ${sets} WHERE id = @__id`).run({ ...Object.fromEntries(entries), __id: id });
  }
  /** Атомарная смена статуса: true, если статус был from */
  transitionGiveaway(id: string, from: GiveawayStatus, to: GiveawayStatus, now: number, extra: Partial<GiveawayRow> = {}): boolean {
    const entries = Object.entries({ ...extra, status: to, updated_at: now });
    const sets = entries.map(([k]) => `${k} = @${k}`).join(', ');
    const r = this.db
      .prepare(`UPDATE giveaways SET ${sets} WHERE id = @__id AND status = @__from`)
      .run({ ...Object.fromEntries(entries), __id: id, __from: from });
    return r.changes === 1;
  }
  getGiveaway(id: string): GiveawayRow | undefined {
    return this.db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id) as GiveawayRow | undefined;
  }
  listCreatorGiveaways(userId: number, limit = 50): GiveawayRow[] {
    return this.db.prepare('SELECT * FROM giveaways WHERE creator_id = ? AND status != ? ORDER BY created_at DESC LIMIT ?').all(userId, 'cancelled', limit) as GiveawayRow[];
  }
  listByStatus(status: GiveawayStatus): GiveawayRow[] {
    return this.db.prepare('SELECT * FROM giveaways WHERE status = ? ORDER BY created_at').all(status) as GiveawayRow[];
  }
  incParticipants(id: string) {
    this.db.prepare('UPDATE giveaways SET participants_count = participants_count + 1 WHERE id = ?').run(id);
  }
  recountParticipants(id: string) {
    this.db
      .prepare(`UPDATE giveaways SET participants_count = (SELECT COUNT(*) FROM participants WHERE giveaway_id = ? AND status = 'active') WHERE id = ?`)
      .run(id, id);
  }

  // ---------- invoices & payments ----------
  insertInvoice(i: Omit<InvoiceRow, 'paid_nano' | 'paid_at'>) {
    this.db
      .prepare(
        `INSERT INTO invoices (id, giveaway_id, comment, amount_nano, amount_usd_cents, ton_usd_rate, status, created_at, expires_at)
         VALUES (@id, @giveaway_id, @comment, @amount_nano, @amount_usd_cents, @ton_usd_rate, @status, @created_at, @expires_at)`,
      )
      .run(i);
  }
  getInvoice(id: string): InvoiceRow | undefined {
    return this.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRow | undefined;
  }
  getInvoiceByComment(comment: string): InvoiceRow | undefined {
    return this.db.prepare('SELECT * FROM invoices WHERE comment = ?').get(comment) as InvoiceRow | undefined;
  }
  latestInvoice(giveawayId: string): InvoiceRow | undefined {
    return this.db.prepare('SELECT * FROM invoices WHERE giveaway_id = ? ORDER BY created_at DESC LIMIT 1').get(giveawayId) as InvoiceRow | undefined;
  }
  updateInvoice(id: string, patch: Partial<InvoiceRow>) {
    const entries = Object.entries(patch);
    const sets = entries.map(([k]) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE invoices SET ${sets} WHERE id = @__id`).run({ ...Object.fromEntries(entries), __id: id });
  }
  /** false — транзакция уже обработана */
  insertPayment(p: { tx_hash: string; lt: string; invoice_id: string | null; source: string | null; amount_nano: string; comment: string | null; utime: number | null }, now: number): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO payments (tx_hash, lt, invoice_id, source, amount_nano, comment, utime, created_at)
         VALUES (@tx_hash, @lt, @invoice_id, @source, @amount_nano, @comment, @utime, @now)`,
      )
      .run({ ...p, now });
    return r.changes === 1;
  }
  paymentSources(invoiceId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT source FROM payments WHERE invoice_id = ? AND source IS NOT NULL').all(invoiceId) as { source: string }[]).map((r) => r.source);
  }

  // ---------- participants ----------
  getParticipant(gid: string, uid: number): ParticipantRow | undefined {
    return this.db.prepare('SELECT * FROM participants WHERE giveaway_id = ? AND user_id = ?').get(gid, uid) as ParticipantRow | undefined;
  }
  getParticipantByRef(gid: string, refCode: string): ParticipantRow | undefined {
    return this.db.prepare('SELECT * FROM participants WHERE giveaway_id = ? AND ref_code = ?').get(gid, refCode) as ParticipantRow | undefined;
  }
  insertParticipant(p: Omit<ParticipantRow, 'status' | 'risk'> & { risk?: number }): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO participants (giveaway_id, user_id, ref_code, referrer_id, country, ip_country, risk, solve_ms, joined_at)
         VALUES (@giveaway_id, @user_id, @ref_code, @referrer_id, @country, @ip_country, @risk, @solve_ms, @joined_at)
         ON CONFLICT(giveaway_id, user_id) DO NOTHING`,
      )
      .run({ risk: 0, ...p });
    return r.changes === 1;
  }
  setParticipantStatus(gid: string, uid: number, status: ParticipantRow['status']) {
    this.db.prepare('UPDATE participants SET status = ? WHERE giveaway_id = ? AND user_id = ?').run(status, gid, uid);
  }
  countActiveReferrals(gid: string, uid: number): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM participants WHERE giveaway_id = ? AND referrer_id = ? AND status = 'active'`)
      .get(gid, uid) as { n: number };
    return r.n;
  }
  /** Участники с числом валидных приглашённых — для розыгрыша */
  drawPool(gid: string): { user_id: number; referrals: number }[] {
    return this.db
      .prepare(
        `SELECT p.user_id AS user_id,
           (SELECT COUNT(*) FROM participants r WHERE r.giveaway_id = p.giveaway_id AND r.referrer_id = p.user_id AND r.status = 'active') AS referrals
         FROM participants p
         LEFT JOIN users u ON u.id = p.user_id
         WHERE p.giveaway_id = ? AND p.status = 'active' AND COALESCE(u.global_ban, 0) = 0
           AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.user_id = p.user_id AND b.giveaway_id IN (p.giveaway_id, '*'))`,
      )
      .all(gid) as { user_id: number; referrals: number }[];
  }

  // ---------- bans ----------
  /** giveawayId = '*' — бан во всех розыгрышах */
  addBan(gid: string, uid: number, reason: string, now: number): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO bans (giveaway_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)').run(gid, uid, reason, now);
    return r.changes === 1;
  }
  getBan(gid: string, uid: number): { reason: string } | undefined {
    return this.db
      .prepare(`SELECT reason FROM bans WHERE user_id = ? AND giveaway_id IN (?, '*') ORDER BY giveaway_id = '*' DESC LIMIT 1`)
      .get(uid, gid) as { reason: string } | undefined;
  }
  /** Снять все баны: вернуть участие и обнулить счётчик ловушек */
  removeBans(uid: number) {
    this.tx(() => {
      this.db.prepare('DELETE FROM bans WHERE user_id = ?').run(uid);
      this.db.prepare('UPDATE users SET honeypot_hits = 0, global_ban = 0 WHERE id = ?').run(uid);
      const gids = this.db.prepare(`SELECT giveaway_id FROM participants WHERE user_id = ? AND status = 'banned'`).all(uid) as { giveaway_id: string }[];
      this.db.prepare(`UPDATE participants SET status = 'active' WHERE user_id = ? AND status = 'banned'`).run(uid);
      for (const g of gids) this.recountParticipants(g.giveaway_id);
    });
  }

  // ---------- captchas ----------
  insertCaptcha(c: Omit<CaptchaRow, 'used'>) {
    this.db
      .prepare('INSERT INTO captchas (id, giveaway_id, user_id, answer_hash, created_at, expires_at) VALUES (@id, @giveaway_id, @user_id, @answer_hash, @created_at, @expires_at)')
      .run(c);
  }
  getCaptcha(id: string): CaptchaRow | undefined {
    return this.db.prepare('SELECT * FROM captchas WHERE id = ?').get(id) as CaptchaRow | undefined;
  }
  /** Одноразовость: true, если капча помечена использованной этим вызовом */
  consumeCaptcha(id: string): boolean {
    return this.db.prepare('UPDATE captchas SET used = 1 WHERE id = ? AND used = 0').run(id).changes === 1;
  }
  countRecentCaptchas(uid: number, since: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM captchas WHERE user_id = ? AND created_at >= ?').get(uid, since) as { n: number }).n;
  }
  purgeCaptchas(before: number) {
    this.db.prepare('DELETE FROM captchas WHERE expires_at < ?').run(before);
  }

  // ---------- winners ----------
  insertWinner(w: { giveaway_id: string; user_id: number; place: number; status: WinnerPrizeStatus }, now: number) {
    this.db
      .prepare('INSERT OR IGNORE INTO winners (giveaway_id, user_id, place, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(w.giveaway_id, w.user_id, w.place, w.status, now, now);
  }
  listWinners(gid: string): (WinnerRow & { username: string | null; first_name: string | null })[] {
    return this.db
      .prepare('SELECT w.*, u.username AS username, u.first_name AS first_name FROM winners w LEFT JOIN users u ON u.id = w.user_id WHERE w.giveaway_id = ? ORDER BY w.place')
      .all(gid) as (WinnerRow & { username: string | null; first_name: string | null })[];
  }
  getWinner(gid: string, uid: number): WinnerRow | undefined {
    return this.db.prepare('SELECT * FROM winners WHERE giveaway_id = ? AND user_id = ?').get(gid, uid) as WinnerRow | undefined;
  }
  /** Все участники (в т.ч. забаненные) — для сопоставления псевдонимов при доразыгрыше */
  participantIds(gid: string): number[] {
    return (this.db.prepare('SELECT user_id FROM participants WHERE giveaway_id = ?').all(gid) as { user_id: number }[]).map((r) => r.user_id);
  }
  dueWinners(now: number, limit = 10): WinnerRow[] {
    return this.db
      .prepare(`SELECT * FROM winners WHERE status IN ('pending', 'needs_username') AND next_attempt_at <= ? ORDER BY created_at LIMIT ?`)
      .all(now, limit) as WinnerRow[];
  }
  updateWinner(gid: string, uid: number, patch: Partial<WinnerRow>, now: number) {
    const entries = Object.entries({ ...patch, updated_at: now });
    const sets = entries.map(([k]) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE winners SET ${sets} WHERE giveaway_id = @__g AND user_id = @__u`).run({ ...Object.fromEntries(entries), __g: gid, __u: uid });
  }
  /** Атомарно забрать приз в обработку */
  claimWinner(gid: string, uid: number, now: number): boolean {
    return (
      this.db
        .prepare(`UPDATE winners SET status = 'processing', updated_at = ? WHERE giveaway_id = ? AND user_id = ? AND status IN ('pending', 'needs_username')`)
        .run(now, gid, uid).changes === 1
    );
  }
  winnersByStatus(status: WinnerPrizeStatus): WinnerRow[] {
    return this.db.prepare('SELECT * FROM winners WHERE status = ? ORDER BY updated_at').all(status) as WinnerRow[];
  }

  // ---------- treasury & refunds ----------
  insertTreasuryOp(op: { kind: string; ref?: string | null; amount_in?: string | null; amount_out?: string | null; status: string; detail?: string | null }, now: number): number {
    const r = this.db
      .prepare('INSERT INTO treasury_ops (kind, ref, amount_in, amount_out, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(op.kind, op.ref ?? null, op.amount_in ?? null, op.amount_out ?? null, op.status, op.detail ?? null, now);
    return Number(r.lastInsertRowid);
  }
  insertRefund(r: { giveaway_id: string; reason: string; usd_cents: number }, now: number) {
    this.db.prepare('INSERT INTO refunds (giveaway_id, reason, usd_cents, created_at) VALUES (?, ?, ?, ?)').run(r.giveaway_id, r.reason, r.usd_cents, now);
  }
  openRefunds(): { id: number; giveaway_id: string; reason: string; usd_cents: number; created_at: number }[] {
    return this.db.prepare(`SELECT * FROM refunds WHERE status = 'open' ORDER BY created_at`).all() as never;
  }

  stats() {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      users: one('SELECT COUNT(*) AS n FROM users'),
      giveawaysActive: one(`SELECT COUNT(*) AS n FROM giveaways WHERE status = 'active'`),
      giveawaysFinished: one(`SELECT COUNT(*) AS n FROM giveaways WHERE status = 'finished'`),
      revenueUsdCents: one(`SELECT COALESCE(SUM(price_usd_cents), 0) AS n FROM giveaways WHERE paid_at IS NOT NULL`),
      costEstimateUsdCents: one(`SELECT COALESCE(SUM(cost_estimate_usd_cents), 0) AS n FROM giveaways WHERE paid_at IS NOT NULL`),
      participants: one('SELECT COUNT(*) AS n FROM participants'),
      bans: one('SELECT COUNT(*) AS n FROM bans'),
      prizesSent: one(`SELECT COUNT(*) AS n FROM winners WHERE status = 'sent'`),
      prizesPending: one(`SELECT COUNT(*) AS n FROM winners WHERE status IN ('pending','processing','needs_username')`),
      prizesFailed: one(`SELECT COUNT(*) AS n FROM winners WHERE status = 'failed'`),
    };
  }
}
