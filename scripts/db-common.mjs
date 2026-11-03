// Shared helpers for scripts/db-backup.mjs and scripts/db-migrate-to-turso.mjs.
// Uses @libsql/client (async; local files via file: URLs, Turso over HTTPS). Never prints tokens.
import { createClient } from '@libsql/client';
import path from 'node:path';

/** Parent-first order (foreign keys). Tables found in the database but not listed here are appended. */
export const KNOWN_TABLES = ['users', 'households', 'sessions', 'family_links', 'spending_policies', 'payment_requests', 'refund_requests', 'refunds', 'approvals', 'webhook_events', 'security_scans', 'user_preferences', 'audit_log'];

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

/** Turso URLs are sent over HTTPS (works behind HTTP proxies; same database as libsql://). */
function normaliseTursoUrl(url) {
  return url.replace(/^libsql:\/\//i, 'https://');
}

/**
 * spec: 'turso' (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN from env), a libsql:// or https:// URL, or a file path.
 * Returns { client, label } where label is safe to print.
 */
export function openTarget(spec) {
  if (!spec || spec === 'turso') {
    const url = process.env.TURSO_DATABASE_URL?.trim();
    if (!url) throw new Error('TURSO_DATABASE_URL is not set.');
    return openUrl(url);
  }
  if (/^(libsql|https?|wss?):\/\//i.test(spec)) return openUrl(spec);
  const file = path.resolve(spec.replace(/^file:/, ''));
  return { client: createClient({ url: 'file:' + file }), label: `file ${path.basename(file)}`, remote: false };
}

function openUrl(url) {
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim() || undefined;
  let host = 'turso';
  try { host = new URL(url).host; } catch { /* generic */ }
  return { client: createClient({ url: normaliseTursoUrl(url), authToken }), label: `Turso ${host}`, remote: true };
}

export async function listTables(client) {
  const rs = await client.execute("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%'");
  const found = new Map(rs.rows.map((r) => [String(r.name), String(r.sql)]));
  const ordered = [...KNOWN_TABLES.filter((t) => found.has(t)), ...[...found.keys()].filter((t) => !KNOWN_TABLES.includes(t)).sort()];
  return ordered.map((name) => ({ name, sql: found.get(name) }));
}

export const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';

export async function readTable(client, table) {
  const rs = await client.execute(`SELECT * FROM ${q(table)} ORDER BY rowid`);
  return { columns: rs.columns, rows: rs.rows.map((r) => Object.fromEntries(rs.columns.map((c) => [c, toJson(r[c])]))) };
}

function toJson(v) {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof ArrayBuffer) return { $base64: Buffer.from(v).toString('base64') };
  return v ?? null;
}
export function fromJson(v) {
  if (v && typeof v === 'object' && '$base64' in v) return Buffer.from(v.$base64, 'base64');
  return v;
}

export async function count(client, table) {
  return Number((await client.execute(`SELECT COUNT(*) AS n FROM ${q(table)}`)).rows[0].n);
}

/** CREATE TABLE x -> CREATE TABLE IF NOT EXISTS x, so applying a schema is idempotent. */
export function idempotentCreate(sql) {
  return sql.replace(/^\s*CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ');
}

export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
  if (v && typeof v === 'object' && '$base64' in v) return `X'${Buffer.from(v.$base64, 'base64').toString('hex')}'`;
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** Strip anything that looks like a token from error text before printing. */
export function safeError(e) {
  return String(e?.message ?? e).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]').replace(/(authToken|Bearer)\s*[:=]?\s*\S+/gi, '$1 [redacted]');
}
