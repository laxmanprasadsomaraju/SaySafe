import { describeDb, openDatabase, resolveDbConfig } from './driver.js';
import { initSchema } from './schema.js';

export { isConstraintError, isUniqueViolation } from './driver.js';

/** Throws at import (i.e. at startup) on bad config, e.g. production without TURSO_DATABASE_URL. */
export const dbConfig = resolveDbConfig();
export const db = openDatabase(dbConfig);
export const dbDescription = describeDb(dbConfig);
initSchema(db);
if (process.env.NODE_ENV !== 'test') console.log(`[db] ${dbDescription}`);


export function audit(householdId: string | null, actor: string, action: string, target?: string, detail?: unknown) {
  db.prepare('INSERT INTO audit_log (household_id, actor, action, target, detail_json) VALUES (?,?,?,?,?)').run(
    householdId, actor, action, target ?? null, detail ? JSON.stringify(detail) : null,
  );
}
