import { describe, it, expect } from 'vitest';
import { spokenScam } from '../web/src/lib/spoken';

describe('spokenScam uses the three public verdicts (and maps legacy codes)', () => {
  it('speaks the verdict label first and never says "safe"', () => {
    const s = spokenScam({ verdict: 'suspicious', phonePolicy: null });
    const n = spokenScam({ verdict: 'needs_checking', phonePolicy: 'x' });
    const o = spokenScam({ verdict: 'no_obvious_warning_signs', phonePolicy: null });
    expect(s.startsWith('Suspicious.')).toBe(true);
    expect(n.startsWith('Needs checking.')).toBe(true);
    expect(n).toContain('or numbers');
    expect(o.startsWith('No obvious warning signs.')).toBe(true);
    expect(o).toContain("can't confirm who sent this");
    for (const t of [s, n, o]) expect(t).not.toMatch(/\bsafe\b/i);
  });
  it('maps legacy and unknown codes like normalizeVerdict()', () => {
    expect(spokenScam({ verdict: 'needs_verification' }).startsWith('Needs checking.')).toBe(true);
    expect(spokenScam({ verdict: 'verified_official_contact' }).startsWith('No obvious warning signs.')).toBe(true);
    expect(spokenScam({ verdict: 'safe' }).startsWith('Needs checking.')).toBe(true);
  });
});

describe('insights model normalises stored scan verdicts', () => {
  it('maps legacy rows in security_scans onto the public codes', async () => {
    process.env.DATABASE_FILE = ':memory:';
    const { db } = await import('../server/db/index');
    const { buildInsights } = await import('../server/insights/model');
    db.prepare("INSERT INTO users (id,name,role) VALUES ('usr_nv','Mary','elder')").run();
    db.prepare("INSERT INTO households (id, elder_id) VALUES ('hh_nv','usr_nv')").run();
    const ins = db.prepare('INSERT INTO security_scans (id, household_id, verdict, summary, shared_with_family) VALUES (?,?,?,?,1)');
    ins.run('scan_nv1', 'hh_nv', 'needs_verification', 'a');
    ins.run('scan_nv2', 'hh_nv', 'verified_official_contact', 'b');
    ins.run('scan_nv3', 'hh_nv', 'suspicious', 'c');
    ins.run('scan_nv4', 'hh_nv', 'something_else', 'd');
    const got = Object.fromEntries(buildInsights('hh_nv', { userId: 'usr_fam', name: 'Ann' }).scans.map((s) => [s.id, s.verdict]));
    expect(got).toEqual({ scan_nv1: 'needs_checking', scan_nv2: 'no_obvious_warning_signs', scan_nv3: 'suspicious', scan_nv4: 'needs_checking' });
  });
});
