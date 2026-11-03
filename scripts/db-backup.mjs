#!/usr/bin/env node
/**
 * Export every table to timestamped JSON (and optionally a SQL dump), from a local SQLite file or Turso.
 *
 *   node scripts/db-backup.mjs                         # Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN)
 *   node scripts/db-backup.mjs --source data/saysafe.db
 *   node scripts/db-backup.mjs --source turso --out backups --dump
 *
 * Output: <out>/saysafe-<UTC timestamp>/{manifest.json, <table>.json[, dump.sql]}
 * manifest.json holds the source label (never the token), each table's CREATE statement and row count.
 * Restore: node scripts/db-migrate-to-turso.mjs --source-backup <dir> [--target turso|<file>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { openTarget, listTables, readTable, parseArgs, sqlLiteral, idempotentCreate, safeError, q } from './db-common.mjs';

const args = parseArgs();
const sourceSpec = args.source ?? (process.env.TURSO_DATABASE_URL ? 'turso' : process.env.DATABASE_FILE ?? 'data/saysafe.db');
const outRoot = path.resolve(args.out ?? 'backups');

try {
  const { client, label } = openTarget(sourceSpec);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(outRoot, `saysafe-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const tables = await listTables(client);
  const manifest = { app: 'saysafe', createdAt: new Date().toISOString(), source: label, tables: [] };
  const dump = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
  for (const t of tables) {
    const { columns, rows } = await readTable(client, t.name);
    fs.writeFileSync(path.join(dir, `${t.name}.json`), JSON.stringify({ table: t.name, columns, rows }, null, 1));
    manifest.tables.push({ name: t.name, rows: rows.length, sql: t.sql });
    if (args.dump) {
      dump.push(idempotentCreate(t.sql) + ';');
      for (const r of rows) dump.push(`INSERT INTO ${q(t.name)} (${columns.map(q).join(',')}) VALUES (${columns.map((c) => sqlLiteral(r[c])).join(',')});`);
    }
    console.log(`  ${t.name.padEnd(20)} ${rows.length} rows`);
  }
  if (args.dump) { dump.push('COMMIT;'); fs.writeFileSync(path.join(dir, 'dump.sql'), dump.join('\n') + '\n'); }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  client.close();
  console.log(`Backup of ${label} written to ${dir}`);
} catch (e) {
  console.error('Backup failed:', safeError(e));
  process.exit(1);
}
