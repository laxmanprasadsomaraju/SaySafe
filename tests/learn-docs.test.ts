// Learn SaySafe docs: structure, screenshots on disk, and the wording rules (no credentials, no false claims).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GUIDES, JUDGE_STEPS, VALUE_PROP, FAQ, PRIVACY, USE_CASES, HOW_IT_WORKS, guideText } from '../web/src/learn/content';
import { FEATURE_GROUPS, ROADMAP } from '../web/src/learn/features';

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'web/public/docs-assets/manifest.json'), 'utf8')) as { shots: Record<string, { file: string; source: string; paypalMock: boolean }> };
const allText = [
  ...GUIDES.map(guideText), ...JUDGE_STEPS.map((s) => `${s.t} ${s.prompt ?? ''}`), ...FAQ.map((f) => `${f.q} ${f.a}`), ...PRIVACY,
  ...USE_CASES.map((u) => `${u.t} ${u.d}`), ...HOW_IT_WORKS.flatMap((h) => h.items),
  ...FEATURE_GROUPS.flatMap((g) => g.items.map((f) => Object.values(f).join(' '))), ...ROADMAP,
].join('\n');
const shotIds = [...GUIDES.flatMap((g) => g.steps.flatMap((s) => (s.shots ?? []).map((x) => x.id))), ...JUDGE_STEPS.flatMap((s) => (s.shot ? [s.shot.id] : []))];

describe('Learn SaySafe structure', () => {
  it('has the 14 guides, numbered 1–14 with unique slugs, each with numbered steps', () => {
    expect(GUIDES.map((g) => g.n)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(new Set(GUIDES.map((g) => g.slug)).size).toBe(14);
    for (const g of GUIDES) expect(g.steps.length).toBeGreaterThanOrEqual(3);
  });
  it('Judge’s Guide has 13 steps and optional steps are marked', () => {
    expect(JUDGE_STEPS).toHaveLength(13);
    expect(JUDGE_STEPS.some((s) => s.optional)).toBe(true);
  });
  it('related links and feature guide links point at real guides', () => {
    const slugs = new Set(GUIDES.map((g) => g.slug));
    for (const g of GUIDES) for (const r of g.related ?? []) expect(slugs.has(r), `${g.slug} → ${r}`).toBe(true);
    for (const f of FEATURE_GROUPS.flatMap((x) => x.items)) if (f.guide) expect(slugs.has(f.guide), f.id).toBe(true);
    for (const s of JUDGE_STEPS) if (s.guide) expect(slugs.has(s.guide)).toBe(true);
  });
  it('uses the value proposition word for word', () => {
    expect(VALUE_PROP).toBe('SaySafe helps people understand payment requests, avoid accidental repeat payments, get trusted assistance and verify payments.');
  });
});

describe('Screenshots', () => {
  it('every referenced screenshot exists (at least one width) and its file is on disk', () => {
    for (const id of shotIds) {
      const keys = [`${id}-390`, `${id}-1440`].filter((k) => manifest.shots[k]);
      expect(keys.length, `missing screenshot ${id}`).toBeGreaterThan(0);
      for (const k of keys) expect(fs.existsSync(path.join(root, 'web/public', manifest.shots[k].file)), k).toBe(true);
    }
  });
  it('follow the naming scheme docs-assets/<guide>/<nn>-<slug>-<w>.webp', () => {
    for (const [k, v] of Object.entries(manifest.shots)) {
      expect(k).toMatch(/^g\d\d\/\d\d-[a-z0-9-]+-(390|1440)$/);
      expect(v.file).toBe(`/docs-assets/${k}.webp`);
    }
  });
  it('local shots that show PayPal details are flagged as mock illustrations', () => {
    for (const [k, v] of Object.entries(manifest.shots)) if (/^g07\/|g05\/03/.test(k) && v.source === 'local') expect(v.paypalMock, k).toBe(true);
  });
});

describe('Wording rules', () => {
  it('contains no credentials', () => {
    expect(allText).not.toMatch(/@personal\.example\.com|sb-[a-z0-9]+@|password\s*[:=]|client[_ ]secret|Bearer\s/i);
  });
  it('never calls something safe as a verdict', () => {
    expect(allText).not.toMatch(/\b(this|the) (message|link|seller) is safe\b|\bit'?s safe\b|\bguaranteed? (safe|genuine)\b/i);
  });
  it('discloses what Insights sends to the AI and that AG Studio is not public', () => {
    expect(allText).toMatch(/permission-filtered records/);
    expect(allText).not.toMatch(/Alex (sees|can see) all|(he|Alex|They) can change (her|your|Mary’s) (family-review )?limit/i);
    expect(allText).toMatch(/Share spending summaries with Alex/);
    expect(allText).toMatch(/Share my purchase history with Alex/);
    expect(allText).toMatch(/AG Studio view exists for evaluation only and is not enabled publicly/);
  });
  it('makes no endorsement, wallet, transfer, fraud-prevention or AI-moves-money claims', () => {
    for (const m of allText.matchAll(/endorsed by/gi)) expect(allText.slice(Math.max(0, m.index! - 40), m.index), 'endorsement wording').toMatch(/\bnot\b|\bnever\b/i);
    // Each of these may appear only as a denial ("never sees", "can't send", "doesn't claim to have prevented").
    for (const re of [/(read|see|access)\w* (your|the buyer’s) PayPal (wallet|account|balance|password)/gi, /send\w* money to a person|SaySafe (sends|sent|transfers) money/gi, /prevent\w* (any )?(fraud|scams)/gi, /AI (pays|moves money|captures|approves)/gi, /take money from your (PayPal )?wallet/gi])
      for (const m of allText.matchAll(re)) expect(allText.slice(Math.max(0, m.index! - 45), m.index), `"${m[0]}" must be a denial`).toMatch(/never|can’t|cannot|can't|not|doesn’t|no\b/i);
    expect(allText).not.toMatch(/AG Studio (runs|is live|is public)/i);
  });
  it('claims voice only where tested and English only as verified', () => {
    expect(allText).toMatch(/iPhone Safari hasn’t been verified/);
    expect(allText).not.toMatch(/iPhone Safari voice (input )?(is not|isn’t) supported/);
    expect(allText).toMatch(/English is the only verified language|English is verified/);
    expect(allText).not.toMatch(/works (on|in) (all|every) browsers?/i);
  });
});
