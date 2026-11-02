// Landing + Mary scenario screenshots and axe (WCAG 2.2 A/AA) checks.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const BASE = process.argv[2] ?? 'http://localhost:8787'; const OUT = process.env.OUT ?? '/tmp/e2e';
const b = await chromium.launch();
const axe = async (p, name) => { const r = await new AxeBuilder({ page: p }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze(); console.log('axe', name, r.violations.length, r.violations.map(v => v.id + ':' + v.nodes.map(n => n.target + ' ' + (n.failureSummary||'').slice(0,400)).join(';')).join(' ')); };
for (const [name, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  const p = await (await b.newContext({ viewport: vp, reducedMotion: 'reduce' })).newPage();
  await p.goto(BASE + '/'); await p.waitForLoadState('networkidle'); await p.waitForTimeout(800);
  await p.addStyleTag({ content: 'header{position:static!important}' });
  await p.getByText('Explore the research').click(); await p.waitForTimeout(300);
  await p.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); } window.scrollTo(0, 0); await Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))); });
  const broken = await p.evaluate(() => [...document.images].filter(i => !i.naturalWidth).map(i => i.src)); console.log('broken images', name, broken.length);
  await p.screenshot({ path: `${OUT}/landing-${name}.png`, fullPage: true });
  await axe(p, 'landing-' + name);
  if (name === 'mobile') {
    await p.getByRole('button', { name: 'Try it free as Mary' }).first().click();
    await p.getByText(/Mary’s story, step 1/).waitFor({ timeout: 15000 });
    await p.getByText(/Suspicious|Needs checking/).first().waitFor({ timeout: 45000 });
    await p.waitForTimeout(1500);
    console.log('scenario verdict text:', (await p.locator('[tabindex="-1"]').first().innerText().catch(() => '')).slice(0, 300).replace(/\n/g, ' | '));
    await p.screenshot({ path: `${OUT}/mary-scene1-mobile.png`, fullPage: true });
    await axe(p, 'mary-scene1');
  }
}
await b.close();
