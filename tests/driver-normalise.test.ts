import { describe, it, expect } from 'vitest';
import { normaliseRow } from '../server/db/driver.js';
describe('normaliseRow (libsql replica row shapes)', () => {
  const cols = ['actor', 'action', 'at'];
  it('keeps plain rows and strips _metadata', () => {
    expect(normaliseRow({ actor: 'a', action: 'x->Y', at: 't', _metadata: { duration: 1 } }, cols)).toEqual({ actor: 'a', action: 'x->Y', at: 't' });
  });
  it('maps array rows by column name', () => {
    expect(normaliseRow(['a', 'x->Y', 't'], cols)).toEqual({ actor: 'a', action: 'x->Y', at: 't' });
  });
  it('maps positionally keyed rows', () => {
    expect(normaliseRow({ 0: 'a', 1: 'x->Y', 2: 't' }, cols)).toEqual({ actor: 'a', action: 'x->Y', at: 't' });
  });
  it('folds upper-cased keyword columns (hosted replica returned ACTION)', () => {
    expect(normaliseRow({ actor: 'a', ACTION: 'x->Y', at: 't' }, cols)).toEqual({ actor: 'a', action: 'x->Y', at: 't' });
  });
  it('drops metadata-only entries', () => {
    expect(normaliseRow({ _metadata: { duration: 1 } }, cols)).toBeUndefined();
    expect(normaliseRow(null, cols)).toBeUndefined();
  });
});
describe('normaliseRow keeps camelCase aliases', () => {
  it('does not lower-case familyId', () => {
    expect(normaliseRow({ familyId: 'f', ACTION: 'a' }, ['familyId', 'action'])).toEqual({ familyId: 'f', action: 'a' });
  });
});
