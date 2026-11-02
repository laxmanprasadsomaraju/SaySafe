// Full-page landing screenshots at several widths and modes, plus checks that the sticky header
// never covers a showcase phone at the moment it scrolls into view, and no horizontal overflow.
// node scripts/shots-landing-qa.mjs [base]
import { chromium } from 'playwright';
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const OUT = process.env.OUT ?? '/tmp/landing-qa';
const b = await chromium.launch();
for (const w of [320, 375, 390, 430, 1440]) for (const mode of ['default', 'large', 'contrast']) {
  if (w === 1440 && mode !== 'default') continue;
  const ctx = await b.newContext({ viewport: { width: w, height: w > 500 ? 900 : 800 }, reducedMotion: 'reduce' });
  await ctx.addInitScript((m) => { if (m === 'large') localStorage.setItem('ss-large', 'on'); if (m === 'contrast') localStorage.setItem('ss-contrast', 'on'); }, mode);
  const p = await ctx.newPage(); await p.goto(BASE + '/'); await p.waitForLoadState('networkidle');
  const res = await p.evaluate(async () => {
    const header = document.querySelector('header'); const out = { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, covered: [], clippedButtons: 0 };
    for (const img of document.querySelectorAll('figure img')) {
      img.scrollIntoView({ block: 'start', behavior: 'instant' }); await new Promise((r) => setTimeout(r, 60));
      const hb = header.getBoundingClientRect().bottom, ib = img.getBoundingClientRect().top;
      if (ib < hb - 1) out.covered.push(img.getAttribute('src'));
    }
    window.scrollTo(0, 0);
    return out;
  });
  await p.screenshot({ path: `${OUT}/${w}-${mode}.png`, fullPage: true });
  console.log(`${res.overflow || res.covered.length ? 'ISSUE' : 'OK   '} ${w}px ${mode} overflow=${res.overflow} header-covers-phone=${res.covered.length}`);
  await ctx.close();
}
await b.close();
