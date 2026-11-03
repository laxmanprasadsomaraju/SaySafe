/** Driver selection, row shape, constraint-error mapping and file persistence for the libsql driver. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resolveDbConfig, describeDb, isConstraintError, isUniqueViolation, DbConfigError } from '../server/db/driver';
import { initSchema, TABLES } from '../server/db/schema';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'saysafe-db-')), 'test.db');

describe('driver selection', () => {
  it('uses a local file when TURSO_DATABASE_URL is unset (dev/tests)', () => {
    expect(resolveDbConfig({ DATABASE_FILE: ':memory:' } as any)).toMatchObject({ mode: 'local', file: ':memory:' });
    expect(resolveDbConfig({} as any).file).toMatch(/data[\\/]saysafe\.db$/);
  });
  it('fails loudly in production without TURSO_DATABASE_URL', () => {
    expect(() => resolveDbConfig({ NODE_ENV: 'production' } as any)).toThrow(DbConfigError);
    expect(() => resolveDbConfig({ NODE_ENV: 'production' } as any)).toThrow(/TURSO_DATABASE_URL is not set/);
    // explicit, documented opt-in only
    expect(resolveDbConfig({ NODE_ENV: 'production', SAYSAFE_ALLOW_EPHEMERAL_DB: 'true' } as any).mode).toBe('local');
  });
  it('selects Turso (embedded replica by default, remote on request) and needs a token', () => {
    const url = 'libsql://example-org.turso.io';
    expect(resolveDbConfig({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 't' } as any)).toMatchObject({ mode: 'replica', url, syncPeriodSeconds: 60 });
    expect(resolveDbConfig({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 't', TURSO_MODE: 'remote' } as any).mode).toBe('remote');
    expect(() => resolveDbConfig({ TURSO_DATABASE_URL: url } as any)).toThrow(/TURSO_AUTH_TOKEN/);
    expect(() => resolveDbConfig({ TURSO_DATABASE_URL: 'postgres://x', TURSO_AUTH_TOKEN: 't' } as any)).toThrow(/libsql:/);
  });
  it('never puts the token in log descriptions or config errors', () => {
    const secret = 'eyJ-super-secret-token';
    const c = resolveDbConfig({ TURSO_DATABASE_URL: 'libsql://example-org.turso.io', TURSO_AUTH_TOKEN: secret } as any);
    expect(describeDb(c)).toBe('Turso embedded replica of example-org.turso.io');
    expect(describeDb(c)).not.toContain(secret);
    try { resolveDbConfig({ TURSO_DATABASE_URL: 'ftp://x', TURSO_AUTH_TOKEN: secret } as any); } catch (e: any) { expect(e.message).not.toContain(secret); }
  });
});

describe('row shape', () => {
  it('rows contain only the selected columns (libsql _metadata stripped); run() returns changes', () => {
    const db = openDatabase(resolveDbConfig({ DATABASE_FILE: ':memory:' } as any));
    db.exec('CREATE TABLE t (a TEXT, b INTEGER)');
    const info = db.prepare('INSERT INTO t VALUES (?,?)').run('x', 1);
    expect(info).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(db.prepare('SELECT a, b FROM t').get()).toEqual({ a: 'x', b: 1 });
    expect(Object.keys(db.prepare('SELECT * FROM t').get() as object)).toEqual(['a', 'b']);
    expect(db.prepare('SELECT a FROM t').all()).toEqual([{ a: 'x' }]);
    expect(db.prepare('SELECT a FROM t WHERE a=?').get('nope')).toBeUndefined();
    expect(db.prepare('INSERT OR IGNORE INTO t (a) SELECT a FROM t WHERE 0').run().changes).toBe(0);
    db.close();
  });
});

describe('constraint-error mapping', () => {
  const db = openDatabase(resolveDbConfig({ DATABASE_FILE: ':memory:' } as any));
  initSchema(db);
  db.prepare("INSERT INTO users (id,name,role) VALUES ('u1','Mary','elder')").run();
  db.prepare("INSERT INTO households (id, elder_id) VALUES ('h1','u1')").run();
  const insertReq = (id: string, order: string | null, key: string | null) =>
    db.prepare("INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint, paypal_order_id, idempotency_key) VALUES (?,?,'DRAFT','[]','m',100,'EUR','fp',?,?)").run(id, 'h1', order, key);
  const err = (fn: () => unknown) => { try { fn(); } catch (e) { return e; } throw new Error('expected a throw'); };

  it('local libsql: UNIQUE and PRIMARY KEY violations are unique violations', () => {
    insertReq('p1', 'ORD-1', 'k1');
    const dupOrder = err(() => insertReq('p2', 'ORD-1', 'k2'));
    const dupKey = err(() => insertReq('p3', 'ORD-3', 'k1'));
    const dupPk = err(() => insertReq('p1', 'ORD-4', 'k4'));
    const dupEvent = (db.prepare("INSERT INTO webhook_events (id, event_type, verified, payload_json) VALUES ('WH-1','X',1,'{}')").run(), err(() => db.prepare("INSERT INTO webhook_events (id, event_type, verified, payload_json) VALUES ('WH-1','X',1,'{}')").run()));
    for (const e of [dupOrder, dupKey, dupPk, dupEvent]) { expect(isUniqueViolation(e)).toBe(true); expect(isConstraintError(e)).toBe(true); }
    expect((dupOrder as any).code).toBe('SQLITE_CONSTRAINT_UNIQUE');
  });
  it('NOT NULL / CHECK are constraint errors but not unique violations', () => {
    const notNull = err(() => db.prepare("INSERT INTO users (id, role) VALUES ('u9','elder')").run());
    const check = err(() => db.prepare("INSERT INTO users (id, name, role) VALUES ('u8','x','admin')").run());
    for (const e of [notNull, check]) { expect(isConstraintError(e)).toBe(true); expect(isUniqueViolation(e)).toBe(false); }
  });
  it('remote/Hrana-shaped errors (generic code, raw code, or message only) map the same way', () => {
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT', message: 'SQLite error: UNIQUE constraint failed: payment_requests.paypal_order_id' })).toBe(true);
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY', message: 'x' })).toBe(true);
    expect(isUniqueViolation({ rawCode: 2067, message: 'x' })).toBe(true);
    expect(isUniqueViolation({ code: 'SERVER_ERROR', message: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: webhook_events.id' })).toBe(true);
    expect(isConstraintError({ rawCode: 1299 })).toBe(true); // NOT NULL extended code
    expect(isUniqueViolation({ rawCode: 1299 })).toBe(false);
    expect(isConstraintError({ code: 'SQLITE_BUSY', message: 'database is locked' })).toBe(false);
    expect(isUniqueViolation(new Error('network down'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
  it('a failed transaction rolls back every statement', () => {
    const before = (db.prepare('SELECT COUNT(*) n FROM payment_requests').get() as any).n;
    expect(() => db.transaction(() => { insertReq('t1', 'ORD-T1', 'kt1'); insertReq('t2', 'ORD-1', 'kt2'); })()).toThrow(/UNIQUE/);
    expect((db.prepare('SELECT COUNT(*) n FROM payment_requests').get() as any).n).toBe(before);
  });
});

describe('restart persistence (file)', () => {
  it('payment request, capture and webhook event survive close + reopen; schema init is idempotent', () => {
    const file = tmpFile();
    const cfg = resolveDbConfig({ DATABASE_FILE: file } as any);
    let db = openDatabase(cfg);
    initSchema(db);
    db.prepare("INSERT INTO users (id,name,role) VALUES ('u1','Mary','elder')").run();
    db.prepare("INSERT INTO households (id, elder_id) VALUES ('h1','u1')").run();
    db.prepare("INSERT INTO payment_requests (id, household_id, state, items_json, merchant, amount_cents, currency, fingerprint, paypal_order_id, paypal_capture_id, captured_amount, captured_currency, idempotency_key) VALUES ('pay_1','h1','CAPTURED','[]','m',1900,'EUR','fp','ORD-1','CAP-1','19.00','EUR','key_1')").run();
    db.prepare("INSERT INTO webhook_events (id, event_type, resource_id, verified, payload_json) VALUES ('WH-1','PAYMENT.CAPTURE.COMPLETED','CAP-1',1,'{}')").run();
    db.close();

    db = openDatabase(cfg);
    initSchema(db); // second boot: CREATE TABLE IF NOT EXISTS must not touch data
    expect(db.prepare('SELECT state, paypal_order_id, paypal_capture_id FROM payment_requests WHERE id=?').get('pay_1')).toEqual({ state: 'CAPTURED', paypal_order_id: 'ORD-1', paypal_capture_id: 'CAP-1' });
    expect(db.prepare('SELECT id, resource_id FROM webhook_events').all()).toEqual([{ id: 'WH-1', resource_id: 'CAP-1' }]);
    // duplicate webhook after restart is still ignored
    expect(db.prepare("INSERT OR IGNORE INTO webhook_events (id, event_type, resource_id, verified, payload_json) VALUES ('WH-1','PAYMENT.CAPTURE.COMPLETED','CAP-1',1,'{}')").run().changes).toBe(0);
    for (const t of TABLES) expect(() => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get()).not.toThrow();
    db.close();
  });
});
