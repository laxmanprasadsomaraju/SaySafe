/** Idempotent schema (CREATE TABLE IF NOT EXISTS only): safe to run on every boot, against a local file or Turso. */
import type { Db } from './driver.js';

export const SCHEMA_SQL = `
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
-- Buyer-facing "Request a refund". A request only: it never moves money and never changes payment state.
CREATE TABLE IF NOT EXISTS refund_requests (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES payment_requests(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('REFUND_REQUESTED','REFUNDED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Merchant (admin) refund execution. One row per payment (full refunds only). The PayPal-Request-Id is written
-- here BEFORE PayPal is called, so a retry after a timeout or restart reuses it and PayPal cannot refund twice.
CREATE TABLE IF NOT EXISTS refunds (
  request_id TEXT PRIMARY KEY REFERENCES payment_requests(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  paypal_request_id TEXT NOT NULL UNIQUE,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('IN_FLIGHT','UNKNOWN','PENDING','COMPLETED','FAILED')),
  refund_id TEXT UNIQUE,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  paypal_status TEXT,
  last_error TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
-- Private shopping profile. Only ever read for the signed-in elder it belongs to (never family, never logs).
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile_json TEXT NOT NULL CHECK (length(profile_json) <= 4096),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Payment companion (elder-only, household-scoped; never read by family endpoints, insights or activity).
-- Column names avoid SQL keywords (the hosted Turso replica upper-cased keyword keys).
CREATE TABLE IF NOT EXISTS companion_payments (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  recipient TEXT NOT NULL CHECK (length(recipient) <= 80),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  paid_on TEXT NOT NULL,
  pay_method TEXT NOT NULL,
  memo TEXT CHECK (memo IS NULL OR length(memo) <= 200),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_companion_payments_hh ON companion_payments(household_id);
CREATE TABLE IF NOT EXISTS companion_subscriptions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  merchant TEXT NOT NULL CHECK (length(merchant) <= 80),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('weekly','monthly','yearly')),
  next_on TEXT,
  memo TEXT CHECK (memo IS NULL OR length(memo) <= 200),
  sub_state TEXT NOT NULL DEFAULT 'tracking' CHECK (sub_state IN ('tracking','instructions_opened','user_reported_cancelled','cancellation_requested','provider_confirmed')),
  -- manual = entered by the user (external merchant); paypal_sandbox_subscription = SaySafe Demo Membership.
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','paypal_sandbox_subscription')),
  evidence_note TEXT,
  confirmed_on TEXT,
  confirmed_by TEXT CHECK (confirmed_by IS NULL OR confirmed_by IN ('user','paypal_api','paypal_webhook')),
  stopped_at TEXT,
  paypal_subscription_id TEXT UNIQUE,
  paypal_status TEXT,
  paypal_approve_url TEXT,
  last_checked_at TEXT,
  webhook_verified INTEGER NOT NULL DEFAULT 0,
  cancel_state TEXT NOT NULL DEFAULT 'none' CHECK (cancel_state IN ('none','in_progress','retry_needed','confirmed')),
  cancel_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- provider_confirmed is only ever set for the PayPal subscription, by the server, after PayPal answered.
  CHECK (sub_state <> 'provider_confirmed' OR source = 'paypal_sandbox_subscription')
);
CREATE INDEX IF NOT EXISTS idx_companion_subscriptions_hh ON companion_subscriptions(household_id);
-- Single-use, short-lived confirmation tokens for cancelling the Demo Membership (a tap, never a spoken "yes").
CREATE TABLE IF NOT EXISTS companion_cancel_tokens (
  token_hash TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS companion_contacts (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) <= 60),
  relation TEXT,
  phone TEXT,
  email TEXT,
  memo TEXT CHECK (memo IS NULL OR length(memo) <= 200),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_companion_contacts_hh ON companion_contacts(household_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** Every table the app owns, in an order that respects foreign keys (parents first). Used by backup/migration scripts. */
export const TABLES = ['users', 'households', 'sessions', 'family_links', 'spending_policies', 'payment_requests', 'refund_requests', 'refunds', 'approvals', 'webhook_events', 'security_scans', 'user_preferences', 'companion_payments', 'companion_subscriptions', 'companion_contacts', 'companion_cancel_tokens', 'audit_log'] as const;

export function initSchema(db: Db) {
  db.exec(SCHEMA_SQL);
}
