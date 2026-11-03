import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';

/** Returns the signed-in person for a role, or redirects to the right start page. */
export function useMe(role: 'elder' | 'family') {
  const [me, setMe] = useState<{ name: string } | null>(null);
  const nav = useNavigate();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => api('/api/me').then((r) => {
      if (cancelled) return;
      const who = r[role];
      if (who) setMe(who);
      else nav(role === 'elder' ? '/' : '/family/pair', { replace: true });
    }).catch(() => {
      // Server unreachable (cold start outlasted the retries, or offline): keep the session and try again,
      // rather than sending the person back to the start page. The banner explains what is happening.
      if (!cancelled) timer = setTimeout(check, 10_000);
    });
    check();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [role, nav]);
  return me;
}
