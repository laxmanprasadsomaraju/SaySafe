/**
 * Sessions and roles. Each demo visitor gets an ISOLATED household (Mary + optional Alex),
 * so judges never see or change each other's data.
 * Elder and family sessions use separate cookies so one browser can open both views in two tabs.
 * Family access requires pairing with a short-lived one-time code created by the elder.
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db, audit } from './db/index.js';

export type Role = 'elder' | 'family';
const COOKIE: Record<Role, string> = { elder: 'ss_elder', family: 'ss_family' };
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const PAIRING_TTL_MS = 1000 * 60 * 15;

export const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const newId = (p: string) => `${p}_${crypto.randomBytes(9).toString('base64url')}`;

export interface Session { userId: string; householdId: string; role: Role; name: string }

function issue(res: Response, role: Role, userId: string, householdId: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, household_id, expires_at) VALUES (?,?,?,?)').run(sha(token), userId, householdId, Date.now() + SESSION_TTL_MS);
  res.cookie(COOKIE[role], token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_TTL_MS, path: '/' });
}

export function startDemoHousehold(res: Response, elderName = 'Mary') {
  const elderId = newId('usr');
  const householdId = newId('hh');
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO users (id, name, role) VALUES (?,?,?)').run(elderId, elderName.slice(0, 40), 'elder');
    db.prepare('INSERT INTO households (id, elder_id) VALUES (?,?)').run(householdId, elderId);
    db.prepare('INSERT INTO spending_policies (household_id, approval_threshold_cents, currency) VALUES (?,?,?)').run(householdId, 7500, 'EUR');
  });
  tx();
  issue(res, 'elder', elderId, householdId);
  audit(householdId, elderId, 'household.created');
  return { householdId, elderId };
}

export function createPairingCode(householdId: string, actor: string) {
  const code = String(crypto.randomInt(100000, 1000000));
  const familyId = newId('usr');
  db.transaction(() => {
    db.prepare('INSERT INTO users (id, name, role) VALUES (?,?,?)').run(familyId, 'Alex', 'family');
    db.prepare('INSERT INTO family_links (household_id, family_id, status, pairing_code_hash, pairing_expires_at) VALUES (?,?,?,?,?)').run(householdId, familyId, 'pending', sha(code), Date.now() + PAIRING_TTL_MS);
  })();
  audit(householdId, actor, 'family.invite_created', familyId);
  return { code, expiresInMinutes: PAIRING_TTL_MS / 60000 };
}

/** One-time: the code is cleared after use, and expires after 15 minutes. */
export function redeemPairingCode(res: Response, code: string, familyName: string) {
  if (!/^\d{6}$/.test(code)) return null;
  const row = db.prepare("SELECT * FROM family_links WHERE pairing_code_hash = ? AND status = 'pending'").get(sha(code)) as any;
  if (!row || row.pairing_expires_at < Date.now()) return null;
  db.transaction(() => {
    db.prepare("UPDATE family_links SET status='active', pairing_code_hash=NULL, pairing_expires_at=NULL WHERE household_id=? AND family_id=?").run(row.household_id, row.family_id);
    db.prepare('UPDATE users SET name=? WHERE id=?').run((familyName || 'Alex').slice(0, 40), row.family_id);
  })();
  issue(res, 'family', row.family_id, row.household_id);
  audit(row.household_id, row.family_id, 'family.paired');
  return { householdId: row.household_id, familyId: row.family_id };
}

/**
 * "Try as Alex too": pairs a family session for the SAME household in this browser, through the normal pairing
 * code flow (a one-time code is created and redeemed server-side, so the code never leaves the server). If this
 * household already has an active Alex, a new family session is issued for that same member.
 * Only the elder of the household can call it (route uses requireRole('elder')).
 */
export function pairDemoFamily(res: Response, householdId: string, actor: string, familyName = 'Alex') {
  const existing = db.prepare("SELECT f.family_id FROM family_links f WHERE f.household_id=? AND f.status='active' ORDER BY f.created_at ASC LIMIT 1").get(householdId) as { family_id: string } | undefined;
  if (existing?.family_id) {
    issue(res, 'family', existing.family_id, householdId);
    audit(householdId, actor, 'family.demo_session', existing.family_id);
    return { familyId: existing.family_id, reused: true };
  }
  const { code } = createPairingCode(householdId, actor);
  const r = redeemPairingCode(res, code, familyName);
  if (!r) throw new Error('pairing failed');
  return { familyId: r.familyId, reused: false };
}

export function readSession(req: Request, role: Role): Session | null {
  const token = req.cookies?.[COOKIE[role]];
  if (!token || typeof token !== 'string') return null;
  const row = db.prepare(
    `SELECT s.user_id, s.household_id, s.expires_at, u.role, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).get(sha(token)) as any;
  if (!row || row.expires_at < Date.now() || row.role !== role) return null;
  if (role === 'family') {
    const link = db.prepare("SELECT status FROM family_links WHERE household_id=? AND family_id=?").get(row.household_id, row.user_id) as any;
    if (link?.status !== 'active') return null;
  }
  return { userId: row.user_id, householdId: row.household_id, role, name: row.name };
}

export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    const s = readSession(req, role);
    if (!s) return res.status(401).json({ error: 'not_signed_in', role });
    (req as any).session = s;
    next();
  };
}

export function logout(req: Request, res: Response, role: Role) {
  const token = req.cookies?.[COOKIE[role]];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
  res.clearCookie(COOKIE[role], { path: '/' });
}

export const sessionOf = (req: Request) => (req as any).session as Session;
