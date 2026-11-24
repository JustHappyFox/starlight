import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

// Миграции только добавляются в конец. Никогда не редактируйте уже выпущенные.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT,
    language_code TEXT,
    is_premium INTEGER NOT NULL DEFAULT 0,
    allows_pm INTEGER NOT NULL DEFAULT 0,
    phone_country TEXT,
    phone_verified_at INTEGER,
    honeypot_hits INTEGER NOT NULL DEFAULT 0,
    global_ban INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE channels (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    username TEXT,
    bot_can_post INTEGER NOT NULL DEFAULT 0,
    bot_can_edit INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE channel_managers (
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX channel_managers_user ON channel_managers(user_id);

  CREATE TABLE giveaways (
    id TEXT PRIMARY KEY,
    creator_id INTEGER NOT NULL,
    channel_id INTEGER,
    status TEXT NOT NULL,
    prize_type TEXT NOT NULL,
    prize_amount INTEGER NOT NULL,
    winners_count INTEGER NOT NULL,
    starts_at INTEGER,
    ends_at INTEGER NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    countries TEXT,
    captcha INTEGER NOT NULL,
    honeypot INTEGER NOT NULL,
    require_subscription INTEGER NOT NULL,
    publish_results INTEGER NOT NULL,
    show_counter INTEGER NOT NULL,
    button_text TEXT NOT NULL,
    post_text TEXT NOT NULL,
    price_usd_cents INTEGER NOT NULL,
    cost_estimate_usd_cents INTEGER NOT NULL,
    seed TEXT NOT NULL,
    seed_hash TEXT NOT NULL,
    post_message_id INTEGER,
    results_message_id INTEGER,
    participants_count INTEGER NOT NULL DEFAULT 0,
    button_count INTEGER NOT NULL DEFAULT -1,
    button_phase TEXT,
    button_updated_at INTEGER NOT NULL DEFAULT 0,
    proof TEXT,
    last_error TEXT,
    paid_at INTEGER,
    published_at INTEGER,
    drawn_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX giveaways_status ON giveaways(status);
  CREATE INDEX giveaways_creator ON giveaways(creator_id, created_at);

  CREATE TABLE invoices (
    id TEXT PRIMARY KEY,
    giveaway_id TEXT NOT NULL,
    comment TEXT NOT NULL UNIQUE,
    amount_nano TEXT NOT NULL,
    paid_nano TEXT NOT NULL DEFAULT '0',
    amount_usd_cents INTEGER NOT NULL,
    ton_usd_rate REAL NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    paid_at INTEGER
  );
  CREATE INDEX invoices_giveaway ON invoices(giveaway_id);

  CREATE TABLE payments (
    tx_hash TEXT PRIMARY KEY,
    lt TEXT NOT NULL,
    invoice_id TEXT,
    source TEXT,
    amount_nano TEXT NOT NULL,
    comment TEXT,
    utime INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE participants (
    giveaway_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    ref_code TEXT NOT NULL,
    referrer_id INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    country TEXT,
    ip_country TEXT,
    risk INTEGER NOT NULL DEFAULT 0,
    solve_ms INTEGER,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (giveaway_id, user_id),
    UNIQUE (giveaway_id, ref_code)
  );
  CREATE INDEX participants_ref ON participants(giveaway_id, referrer_id);

  CREATE TABLE bans (
    giveaway_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  );

  CREATE TABLE captchas (
    id TEXT PRIMARY KEY,
    giveaway_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    answer_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX captchas_user ON captchas(user_id, created_at);

  CREATE TABLE winners (
    giveaway_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    place INTEGER NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    username_used TEXT,
    provider_ref TEXT,
    tx_ref TEXT,
    cost_nano TEXT,
    last_error TEXT,
    notified INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  );
  CREATE INDEX winners_status ON winners(status, next_attempt_at);

  CREATE TABLE treasury_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    ref TEXT,
    amount_in TEXT,
    amount_out TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    giveaway_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    usd_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL
  );
  `,
  // 2: получатель приза может отличаться от победителя (нет ника / Premium уже активен)
  `
  ALTER TABLE winners ADD COLUMN recipient TEXT;
  ALTER TABLE winners ADD COLUMN issue TEXT;
  ALTER TABLE winners ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0;
  `,
];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
