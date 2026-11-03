/**
 * Offline evaluation of the deterministic layer (rules + local blocklist, no AI, no network).
 * The set is small and author-written; the counts printed here are not an accuracy claim.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanMessage } from '../server/scam/guardian';
// @ts-expect-error plain JS helper shared with the live script
import { summarise, formatSummary } from './fixtures/scam-eval/matrix.mjs';

type Case = { id: string; category: string; truth: 'legitimate' | 'scam'; expected: string; text: string };
const load = (f: string) => (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/scam-eval', f), 'utf8')) as { cases: Case[] }).cases;
const cases = load('cases.json');
const holdout = load('holdout.json');

describe('scam eval (offline deterministic layer)', async () => {
  const rows: any[] = [];
  for (const c of cases) {
    const r = await scanMessage(c.text);
    rows.push({ id: c.id, category: c.category, truth: c.truth, expected: c.expected, actual: r.verdict, note: r.signals.filter((s) => s.severity !== 'info').map((s) => s.code).join(',') });
  }
  const s = summarise(rows);
  console.log(formatSummary(s, 'Offline deterministic layer'));

  it('has at least 40 labelled cases', () => expect(cases.length).toBeGreaterThanOrEqual(40));
  it('AI is off in this run', async () => expect((await scanMessage('hello')).ai.used).toBe(false));
  it('no scam gets "No obvious warning signs"', () => expect(s.falseNegatives.map((r: any) => r.id)).toEqual([]));
  it('no legitimate message is called Suspicious', () => expect(s.falsePositives.map((r: any) => r.id)).toEqual([]));
  it('every genuine-PayPal-domain invoice/request with phone or refund instructions is at least Needs checking', () => {
    for (const r of rows.filter((x) => x.category === 'genuine_paypal_domain_phone_invoice')) expect(r.actual, r.id).not.toBe('no_obvious_warning_signs');
  });
  it('phone number + unexpected charge is Suspicious', () => {
    for (const r of rows.filter((x) => x.category === 'genuine_paypal_domain_phone_invoice' && x.expected === 'suspicious')) expect(r.actual, r.id).toBe('suspicious');
  });
  const hoRows: any[] = [];
  for (const c of holdout) {
    const r = await scanMessage(c.text);
    hoRows.push({ id: c.id, category: c.category, truth: c.truth, expected: c.expected, actual: r.verdict });
  }
  const ho = summarise(hoRows);
  console.log(formatSummary(ho, 'Offline deterministic layer — second set (holdout.json)'));
  it('second set: no scam gets "No obvious warning signs"', () => expect(ho.falseNegatives.map((r: any) => r.id)).toEqual([]));

  it('every "No obvious warning signs" result carries the disclosure', async () => {
    for (const c of cases.filter((x) => x.expected === 'no_obvious_warning_signs')) {
      const r = await scanMessage(c.text);
      if (r.verdict === 'no_obvious_warning_signs') expect(r.disclosure).toBe("No concerning signs were found in what you shared. This isn't a guarantee it's safe.");
    }
  });
});

describe('held-out set v2 is frozen', () => {
  it('heldout-v2.json still has the sha256 recorded in docs/SCAM-DETECTION.md (do not tune on it)', async () => {
    const { createHash } = await import('node:crypto');
    const buf = fs.readFileSync(path.join(__dirname, 'fixtures/scam-eval/heldout-v2.json'));
    const hash = createHash('sha256').update(buf).digest('hex');
    expect(hash).toBe('ebbafcdaa9819f42c865e7e7a58779b8876fd25ab12a7fe072a92b73d4e3d48a');
    expect(fs.readFileSync(path.join(__dirname, '../docs/SCAM-DETECTION.md'), 'utf8')).toContain(hash);
  });
  it('offline run is reported, not asserted (results are in heldout-v2-offline.json)', async () => {
    const v2 = load('heldout-v2.json');
    const rows: any[] = [];
    for (const c of v2) { const r = await scanMessage(c.text); rows.push({ id: c.id, category: c.category, truth: c.truth, expected: c.expected, actual: r.verdict }); }
    console.log(formatSummary(summarise(rows), 'Offline deterministic layer — heldout-v2 (frozen, report only)'));
    expect(rows.length).toBe(42);
  });
});
