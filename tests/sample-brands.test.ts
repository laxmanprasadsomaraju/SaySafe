/**
 * Sample data v3: no real brands in "Try as Mary" sample records. Fictional names, clearly labelled sample, no real
 * company cancellation links, and households seeded before v3 are migrated in place (only sample rows).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

vi.hoisted(() => { process.env.API_LIMIT_PER_MIN = '5000'; process.env.AI_SESSION_LIMIT_PER_MIN = '1000'; process.env.COMPANION_LIMIT_PER_MIN = '5000'; });

import { createApp } from '../server/app';
import { db } from '../server/db/index';
import { migrateSampleData, sampleId } from '../server/demo/seed';
import { SAMPLE_RECORDS, SAMPLE_SUBS, SAMPLE_CONTACTS, SAMPLE_SHOP, SAMPLE_RENAMES_V3, DEMO_SEED_VERSION, SAMPLE_CANCEL_NOTICE } from '../shared/demoData';
import { findCancelGuide, CANCEL_GUIDES } from '../shared/cancelGuides';

const app = createApp();
const H = { 'Content-Type': 'application/json' };
beforeAll(() => { process.env.DEMO_SEED = 'on'; });
async function mary() { const a = request.agent(app); await a.post('/api/demo/start').set(H).send({ name: 'Mary' }).expect(200); return a; }

// Real brands that must never appear in sample records (Channel3 real listings are separate and untouched).
const REAL = /\b(netflix|spotify|amazon|prime|irish times|currys|disney|apple|google|sky|now tv|harvey norman|argos|vodafone|eir|tesco)\b/i;

describe('sample data uses fictional companies only', () => {
  it('no real brand in any sample record, subscription, contact or note', () => {
    // `key` is an internal id seed (kept so existing sample ids stay stable); it is never shown. Everything shown is checked.
    const shown = (xs: object[]) => xs.map(({ key: _k, ...rest }: any) => rest);
    const text = JSON.stringify([shown(SAMPLE_RECORDS), shown(SAMPLE_SUBS), shown(SAMPLE_CONTACTS), shown(SAMPLE_SHOP)]);
    expect(text).not.toMatch(REAL);
    expect(DEMO_SEED_VERSION).toBeGreaterThanOrEqual(3);
  });
  it('no sample name matches a real cancellation guide', () => {
    for (const s of SAMPLE_SUBS) expect(findCancelGuide(s.merchant), s.merchant).toBeNull();
    for (const r of SAMPLE_RECORDS) expect(findCancelGuide(r.recipient), r.recipient).toBeNull();
    expect(CANCEL_GUIDES.length).toBeGreaterThan(0); // real guides still exist for subscriptions people add themselves
  });
  it('the renames map every old real-brand sample name to its fictional one', () => {
    for (const r of SAMPLE_RENAMES_V3) {
      expect(r.from).toMatch(REAL);
      expect(r.to).not.toMatch(REAL);
      expect([...SAMPLE_SUBS.map((s) => s.merchant), ...SAMPLE_RECORDS.map((x) => x.recipient)]).toContain(r.to);
    }
  });
});

describe('sample subscriptions: cancel help points to an in-app explanation, never a real company page', () => {
  it('assistant + cancel-help route', async () => {
    const a = await mary();
    const subs = (await a.get('/api/companion/subscriptions').expect(200)).body.subscriptions;
    const samples = subs.filter((s: any) => s.sample);
    expect(samples.map((s: any) => s.merchant)).toEqual(SAMPLE_SUBS.map((s) => s.merchant));
    expect(samples.every((s: any) => s.guide === null && s.managementMethod === 'generic_steps')).toBe(true);
    for (const text of ['Cancel StreamBox Plus', 'cancel my streaming subscription', 'cancel my music subscription', 'cancel TuneWave']) {
      const r = (await a.post('/api/assistant').set(H).send({ text }).expect(200)).body;
      expect(r.companion?.kind, text).toBe('subscription_help');
      expect(r.companion.guide, text).toBeNull();
      expect(r.companion.disclaimer).toBe(SAMPLE_CANCEL_NOTICE);
      expect(r.reply).toMatch(/^Sample data: /);
      expect(JSON.stringify(r.companion)).not.toMatch(/https:\/\/(?!www\.paypal\.com\/myaccount)/); // only the fixed PayPal constant field
    }
    const help = (await a.post(`/api/companion/subscriptions/${samples[0].id}/cancel-help`).set(H).send({}).expect(200)).body;
    expect(help.guide).toBeNull();
    expect(help.subscription.sample).toBe(true);
  });
});

describe('households seeded before v3 are migrated in place', () => {
  it('renames only sample rows, keeps ids/status, leaves records the visitor typed alone, bumps the version', async () => {
    const a = await mary();
    const me = (await a.get('/api/companion/subscriptions').expect(200)).body.subscriptions;
    const hh = (db.prepare('SELECT household_id FROM companion_subscriptions WHERE id=?').get(me[0].id) as any).household_id;
    // Simulate a v2 household: old real-brand sample names, a status the visitor set, and a typed "Netflix" of their own.
    const subId = sampleId('sub', hh, 'netflix');
    db.prepare("UPDATE companion_subscriptions SET merchant='Netflix' WHERE id=?").run(subId);
    db.prepare("UPDATE companion_payments SET recipient='Currys' WHERE id=?").run(sampleId('mpay', hh, 'currys'));
    db.prepare('UPDATE demo_seeds SET seed_version=2 WHERE household_id=?').run(hh);
    await a.post(`/api/companion/subscriptions/${subId}/status`).set(H).send({ to: 'instructions_opened' }).expect(200);
    const own = (await a.post('/api/companion/subscriptions').set(H).send({ merchant: 'Netflix', amountCents: 1399, frequency: 'monthly' }).expect(201)).body;

    expect(migrateSampleData()).toBeGreaterThanOrEqual(2);
    const row = db.prepare('SELECT merchant, sub_state FROM companion_subscriptions WHERE id=?').get(subId) as any;
    expect(row).toEqual({ merchant: 'StreamBox Plus', sub_state: 'instructions_opened' });
    expect((db.prepare('SELECT recipient FROM companion_payments WHERE id=?').get(sampleId('mpay', hh, 'currys')) as any).recipient).toBe('Hearthside Appliances');
    expect((db.prepare('SELECT merchant FROM companion_subscriptions WHERE id=?').get(own.id) as any).merchant).toBe('Netflix'); // typed by the visitor: kept
    expect((db.prepare('SELECT seed_version FROM demo_seeds WHERE household_id=?').get(hh) as any).seed_version).toBe(DEMO_SEED_VERSION);
    expect(migrateSampleData()).toBe(0); // idempotent
  });
});
