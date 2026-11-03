/**
 * Dashboard selection and isolation guarantees:
 *  - explicit config only (INSIGHTS_DASHBOARD + build-time licence), never licence detection
 *  - native is used when the flag is off, when agstudio is selected but no licence ("licence expired"),
 *    and when the AG Studio chunk fails to load or hangs
 *  - the native route and the main bundle never import AG packages
 *  - no AG licence key is committed anywhere in the repo
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { studioAllowed, loadWithTimeout, agStudioLicenseKey } from '../web/src/lib/insightsChoice';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const AG_IMPORT = /from\s+['"](ag-studio|ag-studio-react|ag-grid[\w-]*|ag-charts[\w-]*)['"]|import\(\s*['"](ag-studio|ag-grid|ag-charts)/;

describe('dashboard selection (explicit config)', () => {
  const KEY = { VITE_AG_STUDIO_LICENSE: 'placeholder-not-a-real-key' };
  it('flag off (native) → native, even with a licence', () => {
    expect(studioAllowed({ insights: true, insightsDashboard: 'native' }, KEY)).toBe(false);
    expect(studioAllowed({ insights: true }, KEY)).toBe(false);
  });
  it('agstudio selected but no licence at build ("licence expired" simulation) → native', () => {
    expect(studioAllowed({ insights: true, insightsDashboard: 'agstudio' }, {})).toBe(false);
    expect(studioAllowed({ insights: true, insightsDashboard: 'agstudio' }, { VITE_AG_STUDIO_LICENSE: '' })).toBe(false);
    expect(studioAllowed({ insights: true, insightsDashboard: 'agstudio' }, { VITE_AG_STUDIO_LICENSE: '   ' })).toBe(false);
  });
  it('agstudio + licence → AG Studio allowed; feature off → never', () => {
    expect(studioAllowed({ insights: true, insightsDashboard: 'agstudio' }, KEY)).toBe(true);
    expect(studioAllowed({ insights: false, insightsDashboard: 'agstudio' }, KEY)).toBe(false);
    expect(studioAllowed(null, KEY)).toBe(false);
  });
  it('local evaluation switch is explicit and only ever opt-in', () => {
    expect(studioAllowed({ insightsDashboard: 'agstudio' }, { VITE_AG_STUDIO_LOCAL_EVAL: '1' })).toBe(true);
    expect(studioAllowed({ insightsDashboard: 'native' }, { VITE_AG_STUDIO_LOCAL_EVAL: '1' })).toBe(false);
    expect(studioAllowed({ insightsDashboard: 'agstudio' }, { VITE_AG_STUDIO_LOCAL_EVAL: 'true' })).toBe(false);
  });
  it('licence key is passed through unchanged, blank means none', () => {
    expect(agStudioLicenseKey({ VITE_AG_STUDIO_LICENSE: ' abc ' })).toBe('abc');
    expect(agStudioLicenseKey({})).toBeUndefined();
  });
});

describe('AG Studio lazy import falls back to native', () => {
  it('import rejects → null (StudioRoute then renders NativeInsights)', async () => {
    const failing = () => Promise.reject(new Error('chunk failed to load'));
    await expect(loadWithTimeout(failing, 1000)).resolves.toBeNull();
  });
  it('import hangs → null after the timeout', async () => {
    const hanging = () => new Promise<never>(() => {});
    await expect(loadWithTimeout(hanging, 50)).resolves.toBeNull();
  });
  it('import succeeds → module', async () => {
    const mod = { default: () => null };
    await expect(loadWithTimeout(() => Promise.resolve(mod), 1000)).resolves.toBe(mod);
  });
  it('StudioRoute falls back to NativeInsights for failed loads and render errors', () => {
    const src = read('web/src/pages/insights/StudioRoute.tsx');
    expect(src).toMatch(/Comp === 'failed'\) return <NativeInsights \/>/);
    expect(src).toMatch(/FallbackBoundary fallback=\{<NativeInsights \/>\}/);
    expect(src).toMatch(/if \(!allowed\) return <Navigate to="\/family\/insights" replace \/>/);
  });
});

describe('no AG dependency outside the AG Studio chunk', () => {
  const nativeFiles = [
    'web/src/main.tsx', 'web/src/pages/Family.tsx', 'web/src/pages/insights/NativeInsights.tsx', 'web/src/pages/insights/StudioRoute.tsx',
    'web/src/lib/insightsApi.ts', 'web/src/lib/insightsChoice.ts', 'shared/insights.ts', 'web/src/components/Layout.tsx',
  ];
  it.each(nativeFiles)('%s has no ag-studio / ag-grid / ag-charts import', (f) => {
    expect(read(f)).not.toMatch(AG_IMPORT);
  });
  it('only StudioDashboard.tsx imports AG packages in web/src', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(e.name) && AG_IMPORT.test(read(p))) hits.push(p.replace(/\\/g, '/'));
      }
    };
    walk('web/src');
    expect(hits).toEqual(['web/src/pages/insights/StudioDashboard.tsx']);
  });
  it('the native route only reaches AG through the StudioRoute lazy import', () => {
    expect(read('web/src/pages/insights/NativeInsights.tsx')).not.toMatch(/StudioDashboard|StudioRoute/);
    expect(read('web/src/main.tsx')).not.toMatch(/StudioDashboard/);
  });
  it('built bundles (if present): main index and native chunk contain no AG Studio code', () => {
    const dist = path.join(root, 'web/dist/assets');
    if (!fs.existsSync(dist)) return;
    for (const f of fs.readdirSync(dist).filter((x) => /^(index|NativeInsights)-.*\.js$/.test(x))) {
      const js = fs.readFileSync(path.join(dist, f), 'utf8');
      expect(js, f).not.toMatch(/AgStudioLicenseManager|ag-studio-react|AG Grid Enterprise|ag-charts-enterprise/);
    }
  });
});

describe('no AG licence key committed', () => {
  it('git-tracked files contain no licence strings', () => {
    let files: string[];
    try { files = execSync('git ls-files -co --exclude-standard', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); }
    catch { return; }
    const patterns = [/AG-1\d{5}/, /\[TRIAL\]/, /Using_this_\{AG_/, /_Enterprise_key_\{AG-/, /VITE_AG_STUDIO_LICENSE\s*=\s*\S{20,}/];
    const offenders: string[] = [];
    for (const f of files) {
      if (f.startsWith('node_modules/') || f === 'package-lock.json' || f === 'tests/insights-dashboards.test.ts' || /\.(png|webp|jpg|woff2?|db)$/.test(f)) continue;
      let txt = '';
      try { txt = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
      for (const p of patterns) if (p.test(txt)) offenders.push(`${f} ~ ${p}`);
    }
    expect(offenders).toEqual([]);
  });
});
