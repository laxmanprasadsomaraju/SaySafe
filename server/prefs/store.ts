/**
 * Per-user shopping profile. Private to the signed-in elder: there is deliberately no household-level
 * or family-level read path, nothing is written to audit_log, and values are never logged.
 */
import { db } from '../db/index.js';
import { sanitizeProfile, EMPTY_PROFILE, type ShoppingProfile } from '../../shared/shopping.js';

export function getProfile(userId: string): ShoppingProfile {
  const row = db.prepare('SELECT profile_json FROM user_preferences WHERE user_id=?').get(userId) as { profile_json: string } | undefined;
  if (!row) return { ...EMPTY_PROFILE };
  try { return sanitizeProfile(JSON.parse(row.profile_json)); } catch { return { ...EMPTY_PROFILE }; }
}

export function saveProfile(userId: string, raw: unknown): ShoppingProfile {
  const p = sanitizeProfile(raw);
  const json = JSON.stringify(p);
  if (json.length > 4096) throw new Error('profile too large'); // sanitizeProfile caps lists; this is a backstop
  db.prepare(`INSERT INTO user_preferences (user_id, profile_json, updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at`).run(userId, json);
  return p;
}

export function clearProfile(userId: string) {
  db.prepare('DELETE FROM user_preferences WHERE user_id=?').run(userId);
}
