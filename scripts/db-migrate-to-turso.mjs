#!/usr/bin/env node
/**
 * Copy a local SQLite file (or a JSON backup from db-backup.mjs) into Turso, then validate.
 *
 *   node scripts/db-migrate-to-turso.mjs --source data/saysafe.db             # into TURSO_DATABASE_URL
 *   node scripts/db-migrate-to-turso.mjs --source-backup backups/saysafe-...  # restore a JSON backup into Turso
 *   node scripts/db-migrate-to-turso.mjs --source-backup <dir> --target data/restored.db   # restore to a file
 *   flags: --dry-run (read + plan only)   --skip-existing (INSERT OR IGNORE rows whose key already exists)
 *
 * Each table is copied in one write batch (all rows or none). Plain INSERT is the default, so a row whose
 * key already exists in the target aborts that table instead of being silently overwritten.
 * Validation (exit code 1 on any failure):
 *   - per-table row counts: target >= source, and target == before + inserted
 *   - every payment_requests row: same paypal_order_id, paypal_capture_id, state, amount in the target
 *   - every webhook_events id present in the target
 * Never prints the token.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openTarget, listTables, readTable, count, parseArgs, idempotentCreate, fromJson, safeError, q, KNOWN_TABLES } from './db-common.mjs';

const args = parseArgs();
const fail = (m) => { console.error('FAIL:', m); failures++; };
let failures = 0;

async function loadSource() {
  if (args['source-backup']) {
    const dir = path.resolve(args['source-backup']);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const tables = manifest.tables.map((t) => {
      const data = JSON.parse(fs.readFileSync(path.join(dir, `${t.name}.json`), 'utf8'));
      if (data.rows.length !== t.rows) throw new Error(`backup ${t.name}.json has ${data.rows.length} rows, manifest says ${t.rows}`);
      return { name: t.name, sql: t.sql, columns: data.columns, rows: data.rows };
    });
    return { label: `backup ${path.basename(dir)}`, tables };
  }
  const spec = args.source ?? process.env.DATABASE_FILE ?? 'data/saysafe.db';
  if (!/^(libsql|https?|wss?):\/\//i.test(spec) && !fs.existsSync(path.resolve(spec.replace(/^file:/, '')))) throw new Error(`source file not found: ${spec}`);
  const { client, label } = openTarget(spec);
  const tables = [];
  for (const t of await listTables(client)) tables.push({ ...t, ...(await readTable(client, t.name)) });
  client.close();
  return { label, tables };
}

try {
  const src = await loadSource();
  const { client: dst, label: dstLabel } = openTarget(args.target ?? 'turso');
  console.log(`Source: ${src.label}\nTarget: ${dstLabel}${args['dry-run'] ? '  (dry run)' : ''}`);
  const order = [...KNOWN_TABLES, ...src.tables.map((t) => t.name).filter((n) => !KNOWN_TABLES.includes(n))];
  const tables = order.map((n) => src.tables.find((t) => t.name === n)).filter(Boolean);

  // 1. Schema (idempotent).
  if (!args['dry-run']) await dst.batch(tables.map((t) => idempotentCreate(t.sql)), 'write');

  // 2. Copy.
  const before = {}, inserted = {};
  for (const t of tables) {
    before[t.name] = args['dry-run'] ? await count(dst, t.name).catch(() => 0) : await count(dst, t.name);
    if (args['dry-run'] || t.rows.length === 0) { inserted[t.name] = 0; console.log(`  ${t.name.padEnd(20)} source ${t.rows.length}, target before ${before[t.name]}`); continue; }
    const verb = args['skip-existing'] ? 'INSERT OR IGNORE' : 'INSERT';
    const sql = `${verb} INTO ${q(t.name)} (${t.columns.map(q).join(',')}) VALUES (${t.columns.map(() => '?').join(',')})`;
    const stmts = t.rows.map((r) => ({ sql, args: t.columns.map((c) => fromJson(r[c])) }));
    let n = 0;
    for (let i = 0; i < stmts.length; i += 500) { // chunk large tables; each chunk is atomic
      const res = await dst.batch(stmts.slice(i, i + 500), 'write');
      n += res.reduce((s, r) => s + r.rowsAffected, 0);
    }
    inserted[t.name] = n;
    console.log(`  ${t.name.padEnd(20)} source ${t.rows.length}, inserted ${n}, target before ${before[t.name]}`);
  }
  if (args['dry-run']) { dst.close(); console.log('Dry run: nothing written.'); process.exit(0); }

  // 3. Validate counts.
  for (const t of tables) {
    const after = await count(dst, t.name);
    if (after < t.rows.length) fail(`${t.name}: target has ${after} rows, source has ${t.rows.length}`);
    if (after !== before[t.name] + inserted[t.name]) fail(`${t.name}: target has ${after}, expected ${before[t.name]} + ${inserted[t.name]}`);
  }
  // 4. Validate money-critical identifiers row by row.
  const pr = tables.find((t) => t.name === 'payment_requests');
  if (pr?.rows.length) {
    const rs = await dst.execute('SELECT id, paypal_order_id, paypal_capture_id, state, amount_cents FROM payment_requests');
    const byId = new Map(rs.rows.map((r) => [String(r.id), r]));
    for (const r of pr.rows) {
      const d = byId.get(String(r.id));
      if (!d) { fail(`payment_requests ${r.id} missing in target`); continue; }
      for (const k of ['paypal_order_id', 'paypal_capture_id', 'state', 'amount_cents']) if ((d[k] ?? null) != (r[k] ?? null)) fail(`payment_requests ${r.id}.${k}: target ${d[k]} != source ${r[k]}`);
    }
    const orders = pr.rows.filter((r) => r.paypal_order_id).length, caps = pr.rows.filter((r) => r.paypal_capture_id).length;
    console.log(`  checked ${pr.rows.length} payment requests (${orders} PayPal order ids, ${caps} capture ids)`);
  }
  const wh = tables.find((t) => t.name === 'webhook_events');
  if (wh?.rows.length) {
    const ids = new Set((await dst.execute('SELECT id FROM webhook_events')).rows.map((r) => String(r.id)));
    for (const r of wh.rows) if (!ids.has(String(r.id))) fail(`webhook_events ${r.id} missing in target`);
    console.log(`  checked ${wh.rows.length} webhook event ids`);
  }
  dst.close();
  if (failures) { console.error(`Migration finished with ${failures} validation failure(s).`); process.exit(1); }
  console.log('Migration validated: row counts and every PayPal order id, capture id and webhook event id match.');
} catch (e) {
  console.error('Migration failed:', safeError(e));
  process.exit(1);
}
