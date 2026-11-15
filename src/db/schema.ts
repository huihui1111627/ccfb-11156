import type { Db } from './sqlite.js';

export function initAppSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS destinations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('sms','wecom','ads')),
      base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      destination_id TEXT NOT NULL REFERENCES destinations(id),
      audience_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      confirm_threshold INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_members (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      phone_hash TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (task_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      business_date TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      preview_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      confirmed_at TEXT,
      summary_json TEXT
    );

    CREATE TABLE IF NOT EXISTS send_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      phone_hash TEXT,
      status TEXT NOT NULL,
      deduped INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      attempt_no INTEGER NOT NULL DEFAULT 1,
      batch_id TEXT NOT NULL,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      business_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_send_logs_dest_date ON send_logs(destination_id, business_date);
    CREATE INDEX IF NOT EXISTS idx_send_logs_run ON send_logs(run_id);

    CREATE TABLE IF NOT EXISTS failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      destination_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'open',
      run_id TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL,
      resolved_at TEXT,
      resolve_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_failures_dest ON failures(destination_id, status);
    CREATE INDEX IF NOT EXISTS idx_failures_run ON failures(run_id);

    CREATE TABLE IF NOT EXISTS sms_daily_send (
      business_date TEXT NOT NULL,
      phone TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (business_date, phone)
    );

    CREATE TABLE IF NOT EXISTS daily_usage (
      destination_id TEXT NOT NULL,
      business_date TEXT NOT NULL,
      used_adds INTEGER NOT NULL DEFAULT 0,
      reserved_adds INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (destination_id, business_date)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
}

export function initWarehouseSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      opted_out INTEGER NOT NULL DEFAULT 0,
      blacklisted INTEGER NOT NULL DEFAULT 0,
      opted_out_at TEXT,
      blacklist_reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_opted_out ON users(opted_out);
    CREATE INDEX IF NOT EXISTS idx_users_blacklisted ON users(blacklisted);

    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS segment_members (
      segment_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (segment_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_segment_members_user ON segment_members(user_id);
  `);
}
