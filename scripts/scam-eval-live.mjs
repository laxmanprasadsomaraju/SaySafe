#!/usr/bin/env node
/**
 * Live evaluation of the FULL scan pipeline (rules + local list + Groq text model, and the vision
 * model for the two screenshot fixtures). Costs real API calls; goes slowly (max 2 in parallel)
 * to avoid 429s.
 *
 *   NODE_USE_ENV_PROXY=1 GROQ_API_KEY=... npx tsx scripts/scam-eval-live.mjs [--only=cases|holdout|images] [--from=0 --to=20] [--out=path.json]
 *   (--from/--to slice the selected set so long runs can be split; merge with --merge=a.json,b.json --out=all.json)
 *
 * The set is small and author-written. Report counts, not "accuracy".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_FILE ??= ':memory:';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const { scanMessage, extractFromImage } = await import(path.join(root, 'server/scam/guardian.ts'));
const { aiConfigured, PRIMARY } = await import(path.join(root, 'server/ai/provider.ts'));
const { summarise, formatSummary } = await import(path.join(root, 'tests/fixtures/scam-eval/matrix.mjs'));

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const only = args.only;
const out = args.out ?? path.join(root, 'tests/fixtures/scam-eval/live-results.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONCURRENCY = 2;
const GAP_MS = 1500;

function summaryOf(rows) {
  const ok = rows.filter((r) => r.actual !== 'error');
  const s = summarise(ok);
  return { s, json: { total: s.total, exact: s.exact, matrix: s.matrix, falsePositives: s.falsePositives.map((r) => r.id), falseNegatives: s.falseNegatives.map((r) => r.id), underWarn: s.underWarn.map((r) => r.id), overWarn: s.overWarn.map((r) => r.id), aiNotUsed: rows.filter((r) => r.aiUsed === false).map((r) => r.id), errors: rows.filter((r) => r.actual === 'error').map((r) => r.id) } };
}

if (args.merge) {
  const parts = args.merge.split(',').map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const merged = { ranAt: parts.map((p) => p.ranAt).sort().pop(), textModel: parts[0].textModel, visionModel: parts[0].visionModel, sets: {} };
  for (const p of parts) for (const [k, v] of Object.entries(p.sets)) (merged.sets[k] ??= { rows: [] }).rows.push(...v.rows);
  for (const [k, v] of Object.entries(merged.sets)) { const { s, json } = summaryOf(v.rows); v.summary = json; console.log(formatSummary(s, `Live pipeline — ${k}`)); }
  fs.writeFileSync(out, JSON.stringify(merged, null, 2));
  console.log(`\nWrote ${path.relative(root, out)}`);
  process.exit(0);
}

if (!aiConfigured()) { console.error('GROQ_API_KEY is not set; the live eval needs the AI model.'); process.exit(2); }

async function withBackoff(fn, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fn();
    const err = r?.ai?.error ?? '';
    if (!/429|rate/i.test(err)) return r;
    const wait = 8000 * attempt;
    console.warn(`  ${label}: rate limited, waiting ${wait / 1000}s (attempt ${attempt})`);
    await sleep(wait);
  }
  return fn();
}

async function runPool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
      await sleep(GAP_MS);
    }
  }));
  return results;
}

async function evalSet(file) {
  const all = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/scam-eval', file), 'utf8')).cases;
  const cases = all.slice(Number(args.from ?? 0), args.to ? Number(args.to) : undefined);
  const rows = await runPool(cases, async (c, i) => {
    const t0 = Date.now();
    const r = await withBackoff(() => scanMessage(c.text), c.id);
    const row = {
      id: c.id, category: c.category, truth: c.truth, expected: c.expected, actual: r.verdict,
      aiUsed: r.ai.used, aiModel: r.ai.model ?? null, aiError: r.ai.error ?? null,
      aiReasons: r.aiReasons, ms: Date.now() - t0,
      note: r.signals.filter((s) => s.severity !== 'info').map((s) => s.code).join(','),
    };
    console.log(`  [${i + 1}/${cases.length}] ${c.id}: expected ${c.expected}, got ${r.verdict}${r.ai.used ? '' : ` (AI not used: ${r.ai.error ?? 'unknown'})`}`);
    return row;
  });
  return rows;
}

async function evalImages() {
  const imgs = [
    { id: 'img-fake-paypal-invoice', file: 'tests/fixtures/fake-paypal-invoice.png', truth: 'scam', expected: 'suspicious', category: 'screenshot' },
    { id: 'img-injection-invoice', file: 'tests/fixtures/injection-invoice.png', truth: 'scam', expected: 'suspicious', category: 'screenshot' },
  ];
  const rows = [];
  for (const im of imgs) {
    const buf = fs.readFileSync(path.join(root, im.file));
    let row = { id: im.id, category: im.category, truth: im.truth, expected: im.expected };
    try {
      const ex = await extractFromImage(`data:image/png;base64,${buf.toString('base64')}`);
      const r = await withBackoff(() => scanMessage(ex.text, { extractedFromImage: true, ocrUncertain: ex.uncertain }), im.id);
      row = { ...row, actual: r.verdict, visionModel: ex.model, ocrUncertain: ex.uncertain, extractedChars: ex.text.length, aiUsed: r.ai.used, aiModel: r.ai.model ?? null, aiError: r.ai.error ?? null, note: r.signals.filter((s) => s.severity !== 'info').map((s) => s.code).join(',') };
    } catch (e) {
      row = { ...row, actual: 'error', error: String(e?.message ?? e).slice(0, 300) };
    }
    console.log(`  ${im.id}: expected ${im.expected}, got ${row.actual}${row.error ? ' — ' + row.error : ''}`);
    rows.push(row);
    await sleep(GAP_MS);
  }
  return rows;
}

const report = { ranAt: new Date().toISOString(), textModel: PRIMARY.fastModel, visionModel: PRIMARY.visionModel, sets: {} };
for (const [name, fn] of [['cases', () => evalSet('cases.json')], ['holdout', () => evalSet('holdout.json')], ['images', evalImages]]) {
  if (only && only !== name) continue;
  console.log(`\n== ${name} ==`);
  const rows = await fn();
  const { s, json } = summaryOf(rows);
  console.log(formatSummary(s, `Live pipeline — ${name}`));
  report.sets[name] = { rows, summary: json };
}
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nWrote ${path.relative(root, out)}`);
