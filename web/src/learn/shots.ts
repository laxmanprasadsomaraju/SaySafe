/**
 * Screenshot lookup for the Learn pages. web/public/docs-assets/manifest.json is written by scripts/shots-docs.mjs and
 * says, for every image, its size and where it came from (local test build with mock PayPal, or the hosted app).
 */
import manifest from '../../public/docs-assets/manifest.json';

export interface ShotFile { file: string; width: number; height: number; viewport: number; source: 'local' | 'hosted'; paypalMock: boolean }
const shots = (manifest as { shots: Record<string, ShotFile> }).shots;

/** Both widths of one screenshot id ("g05/03-back-from-paypal"), whichever exist. */
export function shotFiles(id: string): { phone?: ShotFile; desktop?: ShotFile } {
  return { phone: shots[`${id}-390`], desktop: shots[`${id}-1440`] };
}
export const shotCount = (ids: string[]) => ids.reduce((n, id) => { const f = shotFiles(id); return n + (f.phone ? 1 : 0) + (f.desktop ? 1 : 0); }, 0);
export const allShotKeys = () => Object.keys(shots);
