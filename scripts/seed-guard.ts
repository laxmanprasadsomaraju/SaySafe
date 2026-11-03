/**
 * Example/QA seed scripts must never write to a hosted database. Imported FIRST by every seed script, so it runs
 * before the database module opens anything. Refuses when NODE_ENV=production, on Render, or when a remote
 * Turso database is configured (only a local libsql server on localhost is allowed).
 */
export function refuseHostedSeed(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === 'production') return 'NODE_ENV=production';
  if (env.RENDER || env.RENDER_SERVICE_ID) return 'running on Render';
  const url = env.TURSO_DATABASE_URL?.trim();
  if (url && !/^(https?|libsql|wss?):\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)) return 'a remote TURSO_DATABASE_URL is set';
  return null;
}
const why = refuseHostedSeed();
if (why) { console.error(`Refusing to seed example rows: ${why}. Seed scripts are for local QA databases only.`); process.exit(1); }
