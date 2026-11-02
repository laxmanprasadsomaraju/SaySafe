// Screenshot + axe + overflow check for /discover with a live Channel3 search. Usage: BASE=http://127.0.0.1:8787 node scripts/shots-discover.mjs
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const out = process.env.OUT ?? '/tmp/discover';
import fs from 'node:fs'; fs.mkdirSync(out, { recursive: true });
const px = process.env.HTTPS_PROXY || process.env.https_proxy;
let proxy;
if (px) { const u = new URL(px); proxy = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), bypass: 'localhost,127.0.0.1' }; }
const b = await chromium.launch(process.env.SHOT_PROXY && proxy ? { proxy } : {});
for (const [w, h, mode] of [[320, 800, 'large'], [390, 844, 'default'], [1440, 900, 'default'], [390, 844, 'contrast']]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
  await ctx.addInitScript((m) => { if (m === 'contrast') localStorage.setItem('ss-contrast', 'on'); if (m === 'large') localStorage.setItem('ss-large', 'on'); localStorage.setItem('ss-voice', 'off'); }, mode);
  const p = await ctx.newPage();
  await p.request.post(`${BASE}/api/demo/start`, { data: {} });
  await p.goto(`${BASE}/discover`);
  await p.fill('#dq', 'Find me a microwave under €150');
  await p.getByRole('button', { name: 'Search' }).click();
  await p.waitForSelector('section[aria-label="Real products"], [role=alert]', { timeout: 30000 });
  await p.evaluate(async () => { for (const i of document.images) { i.loading = 'eager'; } await new Promise((r) => setTimeout(r, 2500)); });
  const broken = await p.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const axe = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  const cards = await p.locator('section[aria-label="Real products"] article').count();
  await p.screenshot({ path: `${out}/discover-${w}-${mode}.png`, fullPage: true });
  console.log(JSON.stringify({ w, mode, cards, broken, overflow, axe: axe.violations.map((v) => `${v.id}(${v.nodes.length})`) }));
  await ctx.close();
}
await b.close();
