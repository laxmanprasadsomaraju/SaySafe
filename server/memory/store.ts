/**
 * Long-term memory + short conversation context. PRIVATE to the elder who said it.
 * Every function takes (householdId, userId) from the session and every query filters on BOTH.
 * Nothing here writes to audit_log (which feeds family insights) and values are never logged.
 * Memory values are plain data: length-capped, never executed, never sent to PayPal, never a reason to move money.
 */
import { db } from '../db/index.js';
import crypto from 'node:crypto';
import { newId } from '../auth.js';

export type MemoryCategory = 'shopping' | 'brand_like' | 'brand_avoid' | 'budget' | 'communication' | 'other';
export const MEMORY_CATEGORIES: MemoryCategory[] = ['shopping', 'brand_like', 'brand_avoid', 'budget', 'communication', 'other'];
export type MemorySource = 'voice' | 'text' | 'profile';
export interface MemoryItem {
  id: string; category: MemoryCategory; key: string; value: string; source: MemorySource; status: 'confirmed' | 'pending';
  label: string; createdAt: string; updatedAt: string;
  /** A demo sample preference (seeded for "Try as Mary"), not something Mary said. Marked in the data by its id prefix. */
  sample: boolean;
}
export interface RecentProduct {
  productId: string; title: string; price: number; currency: string; retailer: string; origin: 'channel3' | 'demo';
  query: string | null; batch: string; rank: number; item: Record<string, unknown>; shownAt: string;
}

export const MAX_MEMORY_ITEMS = 40;
export const MAX_TURNS = 10;
export const MAX_PRODUCTS = 20;
export const CONTEXT_DAYS = 14;
/** Long-term memory is ON for a user with no saved choice (new households, fresh demo visitors, after demo reset). */
export const MEMORY_DEFAULT_ON = true;
/** Sample memory rows carry this id prefix (no schema change): shown as "Sample", removable, never Mary's own words. */
export const SAMPLE_ID_PREFIX = 'mem_sample_';
export const isSampleId = (id: string) => id.startsWith(SAMPLE_ID_PREFIX);

// A replaceable clock, so tests can move "days later" without waiting.
let clock: () => Date = () => new Date();
export const now = () => clock();
export function setMemoryClock(fn: (() => Date) | null) { clock = fn ?? (() => new Date()); }

const cap = (s: string, n: number) => s.replace(/[\u0000-\u001f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function labelOf(category: MemoryCategory, key: string, value: string): string {
  if (category === 'brand_like') return `Likes the brand ${value}`;
  if (category === 'brand_avoid') return `Doesn't want ${value}`;
  if (category === 'budget') return `Usual budget: up to €${value}`;
  if (category === 'shopping' && key === 'colour') return value.includes(',') ? `Prefers the colours ${value.split(/\s*,\s*/).join(' and ')}` : `Prefers the colour ${value}`;
  if (category === 'shopping' && key.startsWith('style:')) return `Prefers ${value}`;
  if (category === 'communication' && key === 'reply_length') return value === 'short' ? 'Prefers short answers' : `Answers: ${value}`;
  return value;
}

const view = (r: any): MemoryItem => {
  const sample = isSampleId(String(r.id));
  return {
    id: r.id, category: r.category, key: r.mem_key, value: r.mem_value, source: r.source, status: r.mem_status,
    label: `${labelOf(r.category, r.mem_key, r.mem_value)}${sample ? ' (sample)' : ''}`, createdAt: r.created_at, updatedAt: r.updated_at, sample,
  };
};

// ---------- Settings ----------
export function isEnabled(hh: string, userId: string): boolean {
  const r = db.prepare('SELECT enabled FROM memory_settings WHERE user_id=? AND household_id=?').get(userId, hh) as { enabled: number } | undefined;
  return r ? Number(r.enabled) === 1 : MEMORY_DEFAULT_ON;
}
export function setEnabled(hh: string, userId: string, enabled: boolean) {
  db.prepare(`INSERT INTO memory_settings (user_id, household_id, enabled, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`).run(userId, hh, enabled ? 1 : 0, now().toISOString());
}

// ---------- Memory rows ----------
export function listMemory(hh: string, userId: string): MemoryItem[] {
  return (db.prepare('SELECT * FROM user_memory WHERE household_id=? AND user_id=? ORDER BY updated_at DESC, id ASC LIMIT ?').all(hh, userId, MAX_MEMORY_ITEMS) as any[]).map(view);
}
export function getMemory(hh: string, userId: string, id: string): MemoryItem | null {
  const r = db.prepare('SELECT * FROM user_memory WHERE id=? AND household_id=? AND user_id=?').get(id, hh, userId);
  return r ? view(r) : null;
}
/** Insert or replace (unique user_id+category+key): a newer statement replaces the older one, never duplicates. */
export function upsertMemory(hh: string, userId: string, m: { category: MemoryCategory; key: string; value: string; source: MemorySource; status?: 'confirmed' | 'pending' }): MemoryItem {
  const key = cap(m.key, 60).toLowerCase();
  const value = cap(m.value, 120);
  if (!key || !value) throw new Error('empty memory');
  let exists = db.prepare('SELECT id FROM user_memory WHERE user_id=? AND category=? AND mem_key=? AND household_id=?').get(userId, m.category, key, hh) as { id: string } | undefined;
  // Mary saying it herself replaces a sample row: the new row is hers (a fresh id, no "sample" label).
  if (exists && isSampleId(exists.id)) { db.prepare('DELETE FROM user_memory WHERE id=? AND household_id=? AND user_id=?').run(exists.id, hh, userId); exists = undefined; }
  if (!exists) {
    const n = Number((db.prepare('SELECT COUNT(*) AS n FROM user_memory WHERE household_id=? AND user_id=?').get(hh, userId) as any)?.n ?? 0);
    if (n >= MAX_MEMORY_ITEMS) throw new Error('memory full');
  }
  const t = now().toISOString();
  db.prepare(`INSERT INTO user_memory (id, household_id, user_id, category, mem_key, mem_value, source, mem_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, category, mem_key) DO UPDATE SET mem_value=excluded.mem_value, source=excluded.source, mem_status=excluded.mem_status, updated_at=excluded.updated_at`)
    .run(exists?.id ?? newId('mem'), hh, userId, m.category, key, value, m.source, m.status ?? 'confirmed', t, t);
  return view(db.prepare('SELECT * FROM user_memory WHERE user_id=? AND category=? AND mem_key=? AND household_id=?').get(userId, m.category, key, hh));
}
export function updateMemoryValue(hh: string, userId: string, id: string, value: string): MemoryItem | null {
  const v = cap(value, 120);
  if (!v) return null;
  // Correcting a sample makes it Mary's own: it gets a normal id, so it is no longer labelled "sample".
  const nextId = isSampleId(id) ? newId('mem') : id;
  const r = db.prepare('UPDATE user_memory SET id=?, mem_value=?, source=?, mem_status=?, updated_at=? WHERE id=? AND household_id=? AND user_id=?').run(nextId, v, 'profile', 'confirmed', now().toISOString(), id, hh, userId);
  return r.changes ? getMemory(hh, userId, nextId) : null;
}
export function deleteMemory(hh: string, userId: string, id: string): boolean {
  return db.prepare('DELETE FROM user_memory WHERE id=? AND household_id=? AND user_id=?').run(id, hh, userId).changes > 0;
}
export function deleteMemoryWhere(hh: string, userId: string, category: MemoryCategory, key: string): number {
  return db.prepare('DELETE FROM user_memory WHERE household_id=? AND user_id=? AND category=? AND mem_key=?').run(hh, userId, category, key.toLowerCase()).changes;
}
export function latestMemory(hh: string, userId: string): MemoryItem | null {
  const r = db.prepare('SELECT * FROM user_memory WHERE household_id=? AND user_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1').get(hh, userId);
  return r ? view(r) : null;
}

/** Mary asked for short answers ("keep answers short") and memory is on. */
export function wantsShortReplies(hh: string, userId: string): boolean {
  if (!isEnabled(hh, userId)) return false;
  const r = db.prepare("SELECT mem_value FROM user_memory WHERE household_id=? AND user_id=? AND category='communication' AND mem_key='reply_length' AND mem_status='confirmed'").get(hh, userId) as { mem_value: string } | undefined;
  return r?.mem_value === 'short';
}

/** Demo only: two labelled sample preferences so a first-time visitor sees memory working. Replaced on demo reset. */
export const SAMPLE_MEMORY = [
  { key: 'colour', category: 'shopping' as const, value: 'black' },
  { key: 'max', category: 'budget' as const, value: '150' },
];
export function seedSampleMemory(hh: string, userId: string): number {
  const t = now().toISOString();
  let n = 0;
  for (const m of SAMPLE_MEMORY) {
    const id = `${SAMPLE_ID_PREFIX}${crypto.createHash('sha256').update(`${hh}:${userId}:${m.category}:${m.key}`).digest('hex').slice(0, 16)}`;
    // Never overwrite something Mary said herself.
    const r = db.prepare(`INSERT INTO user_memory (id, household_id, user_id, category, mem_key, mem_value, source, mem_status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,'profile','confirmed',?,?) ON CONFLICT DO NOTHING`).run(id, hh, userId, m.category, m.key, m.value, t, t);
    n += Number(r.changes ?? 0);
  }
  return n;
}

// ---------- Conversation context ----------
export function recordTurn(hh: string, userId: string, speaker: 'user' | 'assistant', body: string, via: 'voice' | 'text' = 'text') {
  const text = cap(body, 600);
  if (!text) return;
  db.prepare('INSERT INTO conversation_turns (household_id, user_id, speaker, body, via, created_at) VALUES (?,?,?,?,?,?)').run(hh, userId, speaker, text, via, now().toISOString());
  // Keep only the last MAX_TURNS for this user.
  db.prepare(`DELETE FROM conversation_turns WHERE household_id=? AND user_id=? AND id NOT IN
    (SELECT id FROM conversation_turns WHERE household_id=? AND user_id=? ORDER BY id DESC LIMIT ?)`).run(hh, userId, hh, userId, MAX_TURNS);
}
const sinceIso = () => new Date(now().getTime() - CONTEXT_DAYS * 86_400_000).toISOString();
export function recentTurns(hh: string, userId: string) {
  return (db.prepare('SELECT speaker, body, via, created_at FROM conversation_turns WHERE household_id=? AND user_id=? AND created_at>=? ORDER BY id ASC').all(hh, userId, sinceIso()) as any[])
    .map((r) => ({ speaker: r.speaker as 'user' | 'assistant', text: String(r.body), via: r.via as 'voice' | 'text', at: String(r.created_at) }));
}
export function recordProducts(hh: string, userId: string, items: { productId: string; title: string; price: number; currency: string; retailer: string; item: Record<string, unknown> }[], origin: 'channel3' | 'demo', query: string | null) {
  const list = items.filter((i) => i && typeof i.productId === 'string' && typeof i.title === 'string' && Number.isFinite(i.price)).slice(0, 5);
  if (!list.length) return;
  const batch = newId('bat');
  const t = now().toISOString();
  db.transaction(() => {
    list.forEach((i, idx) => {
      let json = JSON.stringify(i.item);
      if (json.length > 6000) json = JSON.stringify({ ...i.item, description: null, attributes: undefined, features: [] });
      if (json.length > 6000) return;
      // Same product shown again: keep one row (the newest).
      db.prepare('DELETE FROM recent_products WHERE household_id=? AND user_id=? AND product_id=?').run(hh, userId, i.productId.slice(0, 200));
      db.prepare('INSERT INTO recent_products (household_id, user_id, product_id, title, price, currency, retailer, origin, search_query, batch, rank_pos, item_json, shown_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(hh, userId, i.productId.slice(0, 200), cap(i.title, 300), i.price, i.currency, cap(i.retailer, 120), origin, query ? cap(query, 200) : null, batch, idx, json, t);
    });
    db.prepare(`DELETE FROM recent_products WHERE household_id=? AND user_id=? AND id NOT IN
      (SELECT id FROM recent_products WHERE household_id=? AND user_id=? ORDER BY id DESC LIMIT ?)`).run(hh, userId, hh, userId, MAX_PRODUCTS);
  })();
}
/** Newest first. */
export function recentProducts(hh: string, userId: string): RecentProduct[] {
  return (db.prepare('SELECT * FROM recent_products WHERE household_id=? AND user_id=? AND shown_at>=? ORDER BY id DESC LIMIT ?').all(hh, userId, sinceIso(), MAX_PRODUCTS) as any[]).map((r) => {
    let item: Record<string, unknown> = {};
    try { item = JSON.parse(r.item_json); } catch { item = {}; }
    return { productId: r.product_id, title: r.title, price: Number(r.price), currency: r.currency, retailer: r.retailer, origin: r.origin, query: r.search_query ?? null, batch: r.batch, rank: Number(r.rank_pos), item, shownAt: r.shown_at };
  });
}

/** "Clear conversation": only the short conversation context (turns + products shown). Memory items stay. */
export function clearContext(hh: string, userId: string) {
  const counts = { turns: 0, products: 0 };
  db.transaction(() => {
    counts.turns = db.prepare('DELETE FROM conversation_turns WHERE household_id=? AND user_id=?').run(hh, userId).changes;
    counts.products = db.prepare('DELETE FROM recent_products WHERE household_id=? AND user_id=?').run(hh, userId).changes;
  })();
  return counts;
}

/** "Clear all": remembered facts AND conversation context. Leaves the on/off setting as it is unless asked
 * (resetSetting removes the saved choice, so the user is back to the default, which is ON). */
export function clearAll(hh: string, userId: string, opts: { resetSetting?: boolean } = {}) {
  const counts = { memory: 0, turns: 0, products: 0 };
  db.transaction(() => {
    counts.memory = db.prepare('DELETE FROM user_memory WHERE household_id=? AND user_id=?').run(hh, userId).changes;
    counts.turns = db.prepare('DELETE FROM conversation_turns WHERE household_id=? AND user_id=?').run(hh, userId).changes;
    counts.products = db.prepare('DELETE FROM recent_products WHERE household_id=? AND user_id=?').run(hh, userId).changes;
    if (opts.resetSetting) db.prepare('DELETE FROM memory_settings WHERE household_id=? AND user_id=?').run(hh, userId);
  })();
  return counts;
}
