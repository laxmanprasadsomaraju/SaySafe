/** Which person the shared screens (Activity, Profile) are for: the elder (Mary) or the paired family member (Alex). */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from './api';

const KEY = 'ss-role';
export type ShellRole = 'elder' | 'family';
export function rememberRole(r: ShellRole) { try { sessionStorage.setItem(KEY, r); } catch { /* */ } }
export function lastRole(): ShellRole | null { try { const v = sessionStorage.getItem(KEY); return v === 'family' || v === 'elder' ? v : null; } catch { return null; } }

/** Resolves the role from ?as=, then this tab's last role, then whichever session exists. null = no session. */
export function useShellRole(): { role: ShellRole | null; name: string | null; loading: boolean } {
  const [sp] = useSearchParams();
  const hint = sp.get('as') === 'family' ? 'family' : sp.get('as') === 'elder' ? 'elder' : lastRole();
  const [state, setState] = useState<{ role: ShellRole | null; name: string | null; loading: boolean }>({ role: null, name: null, loading: true });
  useEffect(() => {
    let off = false;
    api<{ elder: { name: string } | null; family: { name: string } | null }>('/api/me').then((m) => {
      if (off) return;
      const pick: ShellRole | null = hint && m[hint] ? hint : m.elder ? 'elder' : m.family ? 'family' : null;
      if (pick) rememberRole(pick);
      setState({ role: pick, name: pick ? m[pick]!.name : null, loading: false });
    }).catch(() => { if (!off) setState({ role: null, name: null, loading: false }); });
    return () => { off = true; };
  }, [hint]);
  return state;
}
