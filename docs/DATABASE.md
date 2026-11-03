# Database

SaySafe stores users, households, family links, spending policies, payment requests, approvals, PayPal webhook
events, shared scans and the audit log in SQLite-compatible tables (schema: `server/db/schema.ts`, created with
`CREATE TABLE IF NOT EXISTS` on every boot, so it is idempotent against a fresh or existing database).

## Where the data lives

| Environment | Driver mode | Where | Persistent? |
|---|---|---|---|
| Render (production) | Turso **embedded replica** (default) | Turso Cloud primary, free plan; a local replica file on Render's disk is only a cache | Yes |
| Render, fallback | Turso **remote** (`TURSO_MODE=remote`) | Every statement goes to Turso over the network | Yes |
| Dev / tests | local file | `DATABASE_FILE` (default `data/saysafe.db`), `:memory:` in vitest | Local only |

One package does all three: [`libsql`](https://github.com/tursodatabase/libsql-js), a better-sqlite3-compatible
synchronous driver. No call site changed from the better-sqlite3 days; `server/db/driver.ts` picks the mode.

**Selection rules** (`resolveDbConfig` in `server/db/driver.ts`):

- `TURSO_DATABASE_URL` set → Turso. `TURSO_AUTH_TOKEN` is required (startup fails without it).
- `TURSO_DATABASE_URL` unset → local SQLite file.
- `NODE_ENV=production` and `TURSO_DATABASE_URL` unset → **startup fails loudly** instead of silently writing to
  Render's ephemeral disk. The only way past it is the explicit opt-in `SAYSAFE_ALLOW_EPHEMERAL_DB=true`.
- Credentials are read server-side only. Logs and `/api/health` show the mode and Turso host, never the token.
  `/api/health` reports `db: { mode, persistent }`.

### Why an embedded replica

From the Turso docs ([Embedded Replicas](https://docs.turso.tech/features/embedded-replicas/introduction)):

- Writes are **forwarded to the Turso primary** (not written locally first). Write transactions that contain
  reads also go to the primary.
- **Read-your-writes is guaranteed**: once a write returns, the replica that made it sees it at once, without
  calling `sync()`. SaySafe runs a single Render instance, so every read after a payment or approval write sees it.
- Reads are served locally (fast), and the sync API stays synchronous, so no call site had to become `async`.
- We call `sync()` at boot (startup fails if Turso is unreachable) and libsql syncs in the background every
  `TURSO_SYNC_INTERVAL` seconds (default 60).

Caveats handled in code:

- `PRAGMA journal_mode = WAL` is applied to local files only; Turso manages its own journal.
- `PRAGMA foreign_keys = ON` is best effort on Turso (it may be per connection). Nothing safety-relevant relies on
  cascades, and `scripts/reset-demo.ts` now deletes child rows explicitly.
- libsql adds a `_metadata` timing key to every row from `Statement.get()` and a `duration` key to `run()`
  results. The driver wrapper strips both so rows are exactly the selected columns (this was the one test that
  failed on a plain driver swap).
- Constraint errors: local drivers throw `SQLITE_CONSTRAINT_UNIQUE` / `_PRIMARYKEY`; remote errors may only carry
  `SQLITE_CONSTRAINT`, a numeric extended code, or the message text. `isUniqueViolation()` / `isConstraintError()`
  accept all of them. They are used where a duplicate key is possible: the idempotency-key insert (returns the
  existing request) and attaching a PayPal order/capture id (409 conflict, never a 500).
- Duplicate webhooks use `INSERT OR IGNORE` + `changes === 0`, which behaves the same on every mode.
- If the embedded replica ever misbehaves on Render, set `TURSO_MODE=remote`: same package, same code, every query
  over the network (slower reads, still synchronous).

## Render environment variables

| Key | Value | Notes |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://saysafe-saysafe-lp.aws-eu-west-1.turso.io` | required in production |
| `TURSO_AUTH_TOKEN` | database token from the Turso dashboard | secret (`sync: false`) |
| `TURSO_MODE` | unset (embedded replica) or `remote` | optional |
| `TURSO_SYNC_INTERVAL` | `60` | optional, seconds |
| `TURSO_REPLICA_FILE` | `data/turso-replica.db` | optional; must differ from `DATABASE_FILE` |

No paid Render disk is needed: the replica file is a cache and is rebuilt from Turso on each boot.
Turso free plan (no card): 5 GB storage, 500M rows read and 10M rows written a month, 3 GB of embedded-replica
syncs a month, 1 day of point-in-time restore ([pricing](https://turso.tech/pricing)). Overages are only billed if
you enable them.

## Honest status of today's data

The live Render service currently uses a local SQLite file on Render's **ephemeral** disk. It is wiped on every
deploy, restart and free-tier spin-down, and it holds only demo households and sandbox payments. There is nothing
of value to migrate; the first boot against Turso simply creates the tables.

An empty database is **never** evidence that a PayPal order was not captured. The reconcile logic is unchanged:
a capture with an unknown outcome stays `CAPTURE_PENDING` and a retry reuses the same `PayPal-Request-Id`, so PayPal
cannot capture twice; and `GET /api/paypal/orders/:id/status` asks PayPal directly (read-only, never captures) when
a return from PayPal arrives with no local record.

## Backups (free tier)

1. **Turso point-in-time restore** — automatic, free plan covers the last 24 hours
   ([docs](https://docs.turso.tech/features/point-in-time-recovery)). A restore creates a *new* database:
   `turso db create saysafe-restored --from-db saysafe --timestamp 2026-11-03T10:00:00Z`, then create a token for it
   and point `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` at it.
2. **Manual JSON export** — beyond 24 hours, keep your own copies:

   ```bash
   TURSO_DATABASE_URL=libsql://saysafe-saysafe-lp.aws-eu-west-1.turso.io TURSO_AUTH_TOKEN=... \
     node scripts/db-backup.mjs --out backups --dump
   ```

   Writes `backups/saysafe-<UTC timestamp>/` with one JSON file per table, a `manifest.json` (row counts and
   CREATE statements, no secrets) and, with `--dump`, a `dump.sql` loadable with `sqlite3 new.db < dump.sql`.
   Works against a local file too: `--source data/saysafe.db`. Run it before any risky change, and on a schedule
   from your own machine if the data starts to matter (the `backups/` folder is git-ignored; never commit it).

## Migrating a local file into Turso

```bash
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/db-migrate-to-turso.mjs --source data/saysafe.db [--dry-run]
```

Creates the tables if needed, copies each table in atomic batches with plain `INSERT` (an existing key aborts that
table instead of overwriting; `--skip-existing` uses `INSERT OR IGNORE`), then validates per-table row counts and
that every `paypal_order_id`, `paypal_capture_id`, payment state and amount, and every webhook event id matches.
Exits non-zero on any mismatch.

## Rollback

- **Back to a local file:** unset `TURSO_DATABASE_URL` (and `TURSO_AUTH_TOKEN`). In production you must also set
  `SAYSAFE_ALLOW_EPHEMERAL_DB=true`, because the server otherwise refuses to start on Render's ephemeral disk.
  Data written to Turso stays in Turso and is not copied back.
- **Restore from a JSON backup** (into Turso, or into a file):

  ```bash
  node scripts/db-migrate-to-turso.mjs --source-backup backups/saysafe-<timestamp>               # into Turso
  node scripts/db-migrate-to-turso.mjs --source-backup backups/saysafe-<timestamp> --target data/saysafe.db
  ```

  Restore into an empty database (or a new PITR database); rows whose keys already exist abort the table unless
  `--skip-existing` is given.
- **Code rollback:** redeploy the previous commit. The old better-sqlite3 build reads `DATABASE_FILE` only, so it
  ignores the Turso variables.

## Frontend and state

All financial and approval state comes from the backend on every page load (`/api/me` from the session cookie,
`GET /api/payments/:id` on the order page, `/api/family/overview` on the family page). `localStorage` holds only
display preferences (large text, contrast, voice on/off). During a Render cold start (~50 s) GET requests and
server-deduplicated POSTs (payment creation with its idempotency key, PayPal confirm) retry with backoff while a
"Waking up the server…" banner explains the wait; the session is kept instead of bouncing to the start page.
