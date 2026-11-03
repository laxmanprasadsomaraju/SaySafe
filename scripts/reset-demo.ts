/** Deletes demo households older than N hours (default: all). Usage: npx tsx scripts/reset-demo.ts [hours] */
import { db } from '../server/db/index.js';
const hours = Number(process.argv[2] ?? 0);
const cutoff = hours > 0 ? `datetime('now','-${Math.floor(hours)} hours')` : `datetime('now','+1 day')`;
const ids = (db.prepare(`SELECT id, elder_id FROM households WHERE created_at < ${cutoff}`).all() as any[]);
const tx = db.transaction(() => {
  for (const h of ids) {
    const fam = db.prepare('SELECT family_id FROM family_links WHERE household_id=?').all(h.id) as any[];
    db.prepare('DELETE FROM security_scans WHERE household_id=?').run(h.id);
    db.prepare('DELETE FROM audit_log WHERE household_id=?').run(h.id);
    // Delete children explicitly: Turso connections may not enforce ON DELETE CASCADE (foreign_keys is per connection).
    db.prepare('DELETE FROM approvals WHERE request_id IN (SELECT id FROM payment_requests WHERE household_id=?)').run(h.id);
    db.prepare('DELETE FROM payment_requests WHERE household_id=?').run(h.id);
    db.prepare('DELETE FROM family_links WHERE household_id=?').run(h.id);
    db.prepare('DELETE FROM spending_policies WHERE household_id=?').run(h.id);
    db.prepare('DELETE FROM sessions WHERE household_id=?').run(h.id);
    db.prepare('DELETE FROM households WHERE id=?').run(h.id);
    for (const u of [h.elder_id, ...fam.map((f) => f.family_id)]) {
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u);
      db.prepare('DELETE FROM users WHERE id=?').run(u);
    }
  }
});
tx();
console.log(`Removed ${ids.length} demo household(s).`);
