// Shared by tests/scam-eval.test.ts (offline rules) and scripts/scam-eval-live.mjs (full pipeline).
export const VERDICTS = ['suspicious', 'needs_checking', 'no_obvious_warning_signs'];
const RANK = { no_obvious_warning_signs: 0, needs_checking: 1, suspicious: 2 };

/** rows: [{ id, category, truth, expected, actual }] */
export function summarise(rows) {
  const matrix = Object.fromEntries(VERDICTS.map((e) => [e, Object.fromEntries(VERDICTS.map((a) => [a, 0]))]));
  for (const r of rows) matrix[r.expected][r.actual] = (matrix[r.expected][r.actual] ?? 0) + 1;
  const exact = rows.filter((r) => r.expected === r.actual).length;
  // Over-warning: SaySafe gave a stronger verdict than the policy expects.
  const overWarn = rows.filter((r) => RANK[r.actual] > RANK[r.expected]);
  // Under-warning: weaker than expected. The dangerous kind.
  const underWarn = rows.filter((r) => RANK[r.actual] < RANK[r.expected]);
  // Binary view: a legitimate message called Suspicious (false positive), a scam given "No obvious warning signs" (false negative).
  const falsePositives = rows.filter((r) => r.truth === 'legitimate' && r.actual === 'suspicious');
  const falseNegatives = rows.filter((r) => r.truth === 'scam' && r.actual === 'no_obvious_warning_signs');
  return { total: rows.length, exact, matrix, overWarn, underWarn, falsePositives, falseNegatives };
}

export function formatSummary(s, title) {
  const pad = (x, n) => String(x).padEnd(n);
  const lines = [`== ${title} ==`, `cases: ${s.total}, verdict matches expected: ${s.exact} of ${s.total}`, '', 'rows = expected, columns = actual'];
  lines.push(pad('', 26) + VERDICTS.map((v) => pad(v, 26)).join(''));
  for (const e of VERDICTS) lines.push(pad(e, 26) + VERDICTS.map((a) => pad(s.matrix[e][a], 26)).join(''));
  const list = (name, arr) => { lines.push('', `${name}: ${arr.length}`); for (const r of arr) lines.push(`  - ${r.id} (${r.truth}): expected ${r.expected}, got ${r.actual}${r.note ? ' — ' + r.note : ''}`); };
  list('False positives (legitimate -> Suspicious)', s.falsePositives);
  list('False negatives (scam -> No obvious warning signs)', s.falseNegatives);
  list('Under-warnings (weaker than expected)', s.underWarn);
  list('Over-warnings (stronger than expected)', s.overWarn);
  return lines.join('\n');
}
