/** Audit fix 8: the AG Studio view is opt-in at build time and its Profile link needs agstudio + a licence. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('AG Studio stays out of the public build', () => {
  it('Profile shows "Insights: AG Studio view" only when insightsDashboard === "agstudio" AND a licence is present', () => {
    const src = read('web/src/pages/Profile.tsx');
    expect(src).toMatch(/cfg\?\.insightsDashboard === 'agstudio' && agStudioLicenseKey\(import\.meta\.env\) && <li>.*AG Studio view/);
    expect(src).not.toMatch(/\{cfg\?\.insightsDashboard && <li>/);
  });
  it('the StudioDashboard import sits behind the build-time constant __AG_STUDIO_BUILD__ (licence or local eval)', () => {
    expect(read('web/src/pages/insights/StudioRoute.tsx')).toMatch(/AG_STUDIO_BUILD \? import\('\.\/StudioDashboard'\)/);
    const cfg = read('web/vite.config.ts');
    expect(cfg).toMatch(/__AG_STUDIO_BUILD__: JSON\.stringify\(agStudio\)/);
    expect(cfg).toMatch(/VITE_AG_STUDIO_LICENSE/);
  });
});
