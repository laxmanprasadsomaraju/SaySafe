import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';

/** Returns the signed-in person for a role, or redirects to the right start page. */
export function useMe(role: 'elder' | 'family') {
  const [me, setMe] = useState<{ name: string } | null>(null);
  const nav = useNavigate();
  useEffect(() => {
    api('/api/me').then((r) => {
      const who = r[role];
      if (who) setMe(who);
      else nav(role === 'elder' ? '/' : '/family/pair', { replace: true });
    }).catch(() => nav('/', { replace: true }));
  }, [role, nav]);
  return me;
}
