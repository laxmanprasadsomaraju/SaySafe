/**
 * Private shopping profile. Signed in: stored server-side for this user only.
 * No session: kept in this browser's localStorage instead.
 */
import { api, ApiError } from './api';
import { sanitizeProfile, EMPTY_PROFILE, type ShoppingProfile } from '../../../shared/shopping';

const LOCAL = 'ss-shopping-profile';
const readLocal = () => { try { return sanitizeProfile(JSON.parse(localStorage.getItem(LOCAL) ?? '{}')); } catch { return { ...EMPTY_PROFILE }; } };

export async function loadProfile(): Promise<{ profile: ShoppingProfile; where: 'account' | 'browser' }> {
  try { const r = await api<{ profile: ShoppingProfile }>('/api/preferences'); return { profile: sanitizeProfile(r.profile), where: 'account' }; }
  catch (e) { if (e instanceof ApiError && e.status === 401) return { profile: readLocal(), where: 'browser' }; throw e; }
}
export async function saveProfile(p: ShoppingProfile): Promise<{ profile: ShoppingProfile; where: 'account' | 'browser' }> {
  const clean = sanitizeProfile(p);
  try { const r = await api<{ profile: ShoppingProfile }>('/api/preferences', { method: 'PUT', body: { profile: clean } }); return { profile: r.profile, where: 'account' }; }
  catch (e) { if (e instanceof ApiError && e.status === 401) { localStorage.setItem(LOCAL, JSON.stringify(clean)); return { profile: clean, where: 'browser' }; } throw e; }
}
export async function clearProfile(): Promise<void> {
  localStorage.removeItem(LOCAL);
  try { await api('/api/preferences', { method: 'DELETE' }); } catch (e) { if (!(e instanceof ApiError && e.status === 401)) throw e; }
}
/** Only sent to /api/discover when there is no session (the server uses the account copy otherwise). */
export const localProfileForRequest = readLocal;
