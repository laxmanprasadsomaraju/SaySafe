import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.DATABASE_FILE ?? path.resolve('data/saysafe.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('elder','family')),
  pin_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  elder_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS family_links (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  pairing_code_hash TEXT,
  pairing_expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, family_id)
);
CREATE TABLE IF NOT EXISTS spending_policies (
  household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  approval_threshold_cents INTEGER NOT NULL DEFAULT 7500,
  currency TEXT NOT NULL DEFAULT 'EUR',
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payment_requests (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  items_json TEXT NOT NULL,
  merchant TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  risk_json TEXT,
  paypal_order_id TEXT UNIQUE,
  paypal_capture_id TEXT UNIQUE,
  captured_amount TEXT,
  captured_currency TEXT,
  payee_name TEXT,
  idempotency_key TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','declined','expired','invalidated')),
  decided_by TEXT,
  reason TEXT,
  nonce TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  resource_id TEXT,
  verified INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS security_scans (
  id TEXT PRIMARY KEY,
  household_id TEXT,
  verdict TEXT NOT NULL,
  summary TEXT NOT NULL,
  shared_with_family INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function audit(householdId: string | null, actor: string, action: string, target?: string, detail?: unknown) {
  db.prepare('INSERT INTO audit_log (household_id, actor, action, target, detail_json) VALUES (?,?,?,?,?)').run(
    householdId, actor, action, target ?? null, detail ? JSON.stringify(detail) : null,
  );
}
