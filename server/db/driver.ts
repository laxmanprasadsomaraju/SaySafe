/**
 * Database driver selection. One package (`libsql`, better-sqlite3-compatible, synchronous API) for every mode:
 *
 *  - TURSO_DATABASE_URL set   -> Turso. Default is an embedded replica: reads come from a local replica file,
 *                                writes are forwarded to the Turso primary and are visible to this process as soon
 *                                as they return (read-your-writes). TURSO_MODE=remote skips the replica and sends
 *                                every statement to Turso.
 *  - TURSO_DATABASE_URL unset -> local SQLite file (DATABASE_FILE, default data/saysafe.db), or :memory: in tests.
 *                                Refused when NODE_ENV=production unless SAYSAFE_ALLOW_EPHEMERAL_DB=true, so a
 *                                missing variable can never silently put real data on Render's ephemeral disk.
 *
 * Credentials are read here, server-side only, and never logged: describeDb() prints the host only.
 */
import Database from 'libsql';
import fs from 'node:fs';
import path from 'node:path';

export type DbMode = 'local' | 'replica' | 'remote';

export interface DbConfig {
  mode: DbMode;
  /** Local file (local mode) or replica file (replica mode). Unused in remote mode. */
  file: string;
  /** Turso URL (replica / remote modes). Never includes the token. */
  url?: string;
  authToken?: string;
  /** Background sync period for the embedded replica, seconds. 0 disables it (boot sync still runs). */
  syncPeriodSeconds: number;
}

export interface RunResult { changes: number; lastInsertRowid: number | bigint }
export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface Db {
  readonly mode: DbMode;
  prepare(sql: string): Statement;
  exec(sql: string): void;
  transaction<F extends (...args: any[]) => any>(fn: F): F;
  /** Pull the latest frames from Turso into the replica. No-op for local and remote modes. */
  sync(): void;
  close(): void;
}

export class DbConfigError extends Error {}

const DEFAULT_LOCAL_FILE = 'data/saysafe.db';
const DEFAULT_REPLICA_FILE = 'data/turso-replica.db';

export function resolveDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const url = env.TURSO_DATABASE_URL?.trim();
  const syncPeriodSeconds = Math.max(0, Number(env.TURSO_SYNC_INTERVAL ?? 60) || 0);
  if (url) {
    if (!/^(libsql|https?|wss?):\/\//i.test(url)) throw new DbConfigError('TURSO_DATABASE_URL must start with libsql:// (or https://).');
    const authToken = env.TURSO_AUTH_TOKEN?.trim() || undefined;
    const isLocalServer = /^(https?|libsql|wss?):\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);
    if (!authToken && !isLocalServer) throw new DbConfigError('TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is missing.');
    const mode: DbMode = (env.TURSO_MODE ?? 'replica').trim().toLowerCase() === 'remote' ? 'remote' : 'replica';
    const file = path.resolve(env.TURSO_REPLICA_FILE?.trim() || DEFAULT_REPLICA_FILE);
    const localFile = env.DATABASE_FILE ? path.resolve(env.DATABASE_FILE) : path.resolve(DEFAULT_LOCAL_FILE);
    // A plain SQLite file must never be opened as a replica (libsql would overwrite or reject it).
    if (mode === 'replica' && file === localFile) throw new DbConfigError('TURSO_REPLICA_FILE must not be the same file as DATABASE_FILE.');
    return { mode, file, url, authToken, syncPeriodSeconds };
  }
  if (env.NODE_ENV === 'production' && env.SAYSAFE_ALLOW_EPHEMERAL_DB !== 'true') {
    throw new DbConfigError(
      'TURSO_DATABASE_URL is not set. Refusing to start in production on a local SQLite file, which Render wipes on every restart. ' +
      'Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, or set SAYSAFE_ALLOW_EPHEMERAL_DB=true to accept an ephemeral demo database.',
    );
  }
  const raw = env.DATABASE_FILE ?? DEFAULT_LOCAL_FILE;
  return { mode: 'local', file: raw === ':memory:' ? raw : path.resolve(raw), syncPeriodSeconds: 0 };
}

/** Safe one-line description for logs: never contains the token. */
export function describeDb(c: DbConfig): string {
  if (c.mode === 'local') return `local SQLite (${c.file === ':memory:' ? 'in memory' : path.basename(c.file)})`;
  let host = 'turso';
  try { host = new URL(c.url!).host; } catch { /* keep generic */ }
  return c.mode === 'replica' ? `Turso embedded replica of ${host}` : `Turso remote ${host}`;
}

/**
 * libsql attaches query timing to every row from Statement.get() as an enumerable `_metadata` key, and a
 * `duration` key to run() results. better-sqlite3 returns plain rows. Strip both so rows stay exactly the
 * columns selected (this is what broke deep-equality on rows, and would leak into anything that spreads a row).
 */
function cleanRow<T>(row: T): T {
  if (row && typeof row === 'object' && !Array.isArray(row) && '_metadata' in (row as object)) delete (row as any)._metadata;
  return row;
}

/**
 * Normalise a row from any libsql mode to a plain {column: value} object. Seen on the hosted Turso embedded
 * replica (2026-11-03): .all() rows that lacked the selected keys, so `row.action` was undefined. Arrays are
 * mapped through the statement's column names; metadata-only/empty entries are dropped.
 */
export function normaliseRow(row: unknown, columns: string[] | null): Record<string, unknown> | undefined {
  if (row == null) return undefined;
  if (Array.isArray(row)) {
    if (!columns || columns.length !== row.length) return undefined;
    return Object.fromEntries(columns.map((c, i) => [c, row[i]]));
  }
  if (typeof row !== 'object') return undefined;
  const r = cleanRow(row as Record<string, unknown>);
  // The hosted Turso embedded replica returned `ACTION` for `action` (SQL keyword upper-cased). SaySafe columns
  // are lower-case snake_case (aliases may be camelCase, which stay), so fold only ALL-CAPS keys to lower-case when that key is not already present.
  for (const k of Object.keys(r)) {
    const lk = k.toLowerCase();
    if (lk !== k && k === k.toUpperCase() && !(lk in r)) { r[lk] = r[k]; delete r[k]; }
  }
  if (columns && columns.length && !columns.some((c) => c in r)) {
    // keyed differently (e.g. table-qualified or positional keys): map by position over the column list
    const vals = Object.entries(r).filter(([k]) => k !== '_metadata' && k !== 'duration').map(([, v]) => v);
    if (vals.length === columns.length) return Object.fromEntries(columns.map((c, i) => [c, vals[i]]));
    return undefined;
  }
  return r;
}

function columnNames(stmt: any): string[] | null {
  try { const cols = stmt.columns?.(); return Array.isArray(cols) ? cols.map((c: any) => { const n = String(c?.name ?? c); return n === n.toUpperCase() ? n.toLowerCase() : n; }) : null; } catch { return null; }
}

function wrapStatement(stmt: any): Statement {
  let cols: string[] | null | undefined;
  const names = () => (cols === undefined ? (cols = columnNames(stmt)) : cols);
  return {
    run: (...p) => { const info = stmt.run(...p); return { changes: Number(info.changes), lastInsertRowid: info.lastInsertRowid }; },
    get: (...p) => { const r = stmt.get(...p); return r == null ? r : (normaliseRow(r, names()) as any); },
    all: (...p) => {
      const out = (stmt.all(...p) as unknown[]).map((r) => normaliseRow(r, names())).filter((r): r is Record<string, unknown> => !!r);
      return out as any;
    },
  };
}

export function openDatabase(c: DbConfig): Db {
  let raw: any;
  if (c.mode === 'remote') {
    raw = new Database(c.url!, { authToken: c.authToken } as any);
  } else {
    if (c.file !== ':memory:') fs.mkdirSync(path.dirname(c.file), { recursive: true });
    raw = c.mode === 'replica'
      ? new Database(c.file, { syncUrl: c.url, authToken: c.authToken, syncPeriod: c.syncPeriodSeconds, readYourWrites: true } as any)
      : new Database(c.file);
  }
  if (c.mode === 'replica') raw.sync(); // boot: pull the primary's state before serving anything. Throws (and so fails startup) if Turso is unreachable.
  if (c.mode === 'local') {
    if (c.file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL'); // local files only; Turso manages its own journal
    raw.exec('PRAGMA foreign_keys = ON');
  } else {
    // Best effort: Turso may scope this per connection/stream. The app never relies on cascades for safety,
    // and scripts/reset-demo.ts deletes children explicitly.
    try { raw.exec('PRAGMA foreign_keys = ON'); } catch { /* not supported on this connection */ }
  }
  return {
    mode: c.mode,
    prepare: (sql) => wrapStatement(raw.prepare(sql)),
    exec: (sql) => { raw.exec(sql); },
    transaction: (fn) => raw.transaction(fn),
    sync: () => { if (c.mode === 'replica') raw.sync(); },
    close: () => { raw.close(); },
  };
}

/**
 * True for SQLite constraint violations from any driver/mode: local libsql and better-sqlite3 throw
 * SqliteError with code 'SQLITE_CONSTRAINT_UNIQUE' etc.; remote (Hrana) errors may only carry the generic
 * 'SQLITE_CONSTRAINT' code, a numeric extended rawCode, or just the SQLite message text.
 */
export function isConstraintError(e: unknown): boolean {
  const err = e as any;
  if (!err) return false;
  const code = String(err.code ?? '');
  if (code.startsWith('SQLITE_CONSTRAINT')) return true;
  if (typeof err.rawCode === 'number' && (err.rawCode & 0xff) === 19) return true; // SQLITE_CONSTRAINT primary code
  return /\b(UNIQUE|PRIMARY KEY|NOT NULL|CHECK|FOREIGN KEY) constraint failed\b/i.test(String(err.message ?? ''));
}

/** True only for UNIQUE / PRIMARY KEY violations (duplicate key), not NOT NULL / CHECK / FK. */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as any;
  if (!err) return false;
  const code = String(err.code ?? '');
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  if (typeof err.rawCode === 'number' && (err.rawCode === 2067 || err.rawCode === 1555)) return true;
  return /\bUNIQUE constraint failed\b/i.test(String(err.message ?? ''));
}
