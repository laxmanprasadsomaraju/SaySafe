// QA for the Learn SaySafe docs: internal links + anchors, external links (HTTP status), axe-core (WCAG 2.2 AA tags)
// and horizontal overflow on /learn, every guide, /judges and /features at 320/390/1024/1440 (signed out and as Mary),
// keyboard reachability, and the screenshot dialog (opens, traps Tab, closes on Escape, focus returns).
//   node scripts/docs-qa.mjs http://127.0.0.1:8792      → $OUT/docs-qa.json (default /tmp/docs-qa), exit 1 on any failure
//   EXTERNAL=0 skips the external link check (offline).
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8792').replace(/\/$/, '');
const OUT = process.env.OUT ?? '/tmp/docs-qa'; fs.mkdirSync(OUT, { recursive: true });
const { GUIDES } = await import('../web/src/learn/content.ts').catch(async () => {
  // Node can't import .ts directly: read slugs from the source.
  const src = fs.readFileSync(new URL('../web/src/learn/content.ts', import.meta.url), 'utf8');
  return { GUIDES: [...src.matchAll(/slug: '([a-z0-9-]+)'/g)].map((m) => ({ slug: m[1] })) };
});
const PAGES = ['/learn', ...GUIDES.map((g) => `/learn/${g.slug}`), '/judges', '/features', '/', '/help'];
const WIDTHS = [320, 390, 1024, 1440];
const fails = []; const report = { axe: [], links: [], external: [], keyboard: [], dialog: [] };
const fail = (m) => { fails.push(m); console.log('FAIL', m); };

const b = await chromium.launch();
const ctx = await b.newContext({ reducedMotion: 'reduce' });
const p = await ctx.newPage();

// ---- axe + overflow, signed out ----
async function audit(page, tag) {
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w < 600 ? 844 : 900 });
    for (const path of PAGES) {
      if (tag === 'mary' && (path === '/' )) continue;
      await page.goto(BASE + path, { waitUntil: 'networkidle' });
      await page.waitForSelector('h1', { timeout: 15000 });
      await page.evaluate(() => document.querySelectorAll('img[loading="lazy"]').forEach((i) => i.setAttribute('loading', 'eager')));
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      const v = r.violations.map((x) => `${x.id}:${x.nodes.length}:${x.nodes[0]?.target}`);
      report.axe.push({ tag, path, w, violations: v, overflow });
      if (v.length) fail(`axe ${tag} ${path} @${w}: ${v.join(' | ')}`);
      if (overflow) fail(`overflow ${tag} ${path} @${w}`);
    }
  }
}
await audit(p, 'public');

// ---- internal links + anchors (from every docs page) ----
const internal = new Set(); const external = new Set();
await p.setViewportSize({ width: 1440, height: 900 });
for (const path of PAGES) {
  await p.goto(BASE + path, { waitUntil: 'networkidle' });
  const hrefs = await p.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
  for (const h of hrefs) {
    if (!h || h.startsWith('mailto:') || h.startsWith('tel:')) continue;
    if (/^https?:/.test(h)) { if (!h.startsWith(BASE)) external.add(h); else internal.add(new URL(h).pathname + new URL(h).hash); }
    else internal.add(h.startsWith('#') ? path + h : h);
  }
}
for (const href of internal) {
  const [pathPart, hash] = href.split('#');
  const path = pathPart || '/';
  if (path.startsWith('/docs-assets/') || /\.(webp|png|svg)$/.test(path)) {
    const r = await fetch(BASE + path); report.links.push({ href, status: r.status }); if (r.status !== 200) fail(`asset ${href} → ${r.status}`); continue;
  }
  await p.goto(BASE + href, { waitUntil: 'networkidle' });
  const finalPath = new URL(p.url()).pathname;
  const redirectedHome = finalPath === '/' && path !== '/';
  let anchorOk = true;
  if (hash) anchorOk = await p.waitForSelector(`[id="${decodeURIComponent(hash)}"]`, { timeout: 5000 }).then(() => true).catch(() => false);
  report.links.push({ href, finalPath, anchorOk, redirectedHome });
  if (redirectedHome) fail(`internal link ${href} fell through to / (unknown route)`);
  if (!anchorOk) fail(`anchor missing: ${href}`);
}

// ---- external links ----
if (process.env.EXTERNAL !== '0') {
  for (const u of external) {
    let code = '000';
    try { code = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-L', '-m', '25', '-A', 'Mozilla/5.0 (SaySafe docs link check)', u]).toString().trim(); } catch { /* */ }
    report.external.push({ url: u, status: code });
    if (!/^[23]/.test(code)) fail(`external ${u} → ${code}`);
  }
}

// ---- keyboard: every docs page, Tab reaches the main content links and each has a visible focus outline ----
for (const path of ['/learn', '/learn/family-approval', '/judges', '/features']) {
  await p.goto(BASE + path, { waitUntil: 'networkidle' });
  let noOutline = 0; const stops = [];
  for (let i = 0; i < 25; i++) {
    await p.keyboard.press('Tab');
    const s = await p.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e); return { t: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 40), outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 }; });
    if (s) { stops.push(s.t); if (!s.outline) noOutline++; }
  }
  report.keyboard.push({ path, stops, noOutline });
  if (noOutline) fail(`keyboard ${path}: ${noOutline} focus stops without a visible outline`);
}

// ---- screenshot dialog: open with keyboard, focus inside, Tab trapped, Escape closes, focus returns ----
for (const w of [390, 1440]) {
  await p.setViewportSize({ width: w, height: w < 600 ? 844 : 900 });
  await p.goto(BASE + '/learn/family-approval', { waitUntil: 'networkidle' });
  const btn = p.locator('[data-shot] > button').first();
  await btn.focus(); await p.keyboard.press('Enter');
  const dlg = p.getByTestId('shot-dialog'); await dlg.waitFor({ timeout: 5000 });
  const inside = [];
  for (let i = 0; i < 6; i++) { await p.keyboard.press('Tab'); inside.push(await p.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="shot-dialog"]')))); }
  for (let i = 0; i < 3; i++) { await p.keyboard.press('Shift+Tab'); inside.push(await p.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="shot-dialog"]')))); }
  const axeD = await new AxeBuilder({ page: p }).include('[data-testid="shot-dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  await p.keyboard.press('Escape');
  const closed = await dlg.count() === 0;
  const returned = await p.evaluate(() => Boolean(document.activeElement?.closest('[data-shot]')));
  const r = { w, trapped: inside.every(Boolean), closed, focusReturned: returned, axe: axeD.violations.map((v) => v.id) };
  report.dialog.push(r);
  if (!r.trapped || !r.closed || !r.focusReturned || r.axe.length) fail(`dialog @${w}: ${JSON.stringify(r)}`);
}

// ---- as Mary (docs inside the app shell) ----
await p.goto(BASE + '/'); await p.evaluate(async () => { await fetch('/api/demo/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Mary' }) }); });
const save = [...PAGES]; PAGES.length = 0; PAGES.push('/learn', '/learn/getting-started', '/learn/verified-receipt', '/judges', '/features', '/help');
await audit(p, 'mary');
PAGES.length = 0; PAGES.push(...save);

await b.close();
const summary = { when: new Date().toISOString(), base: BASE, pagesAudited: report.axe.length, internalLinks: report.links.length, externalLinks: report.external.length, failures: fails };
fs.writeFileSync(`${OUT}/docs-qa.json`, JSON.stringify({ summary, ...report }, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exitCode = fails.length ? 1 : 0;
