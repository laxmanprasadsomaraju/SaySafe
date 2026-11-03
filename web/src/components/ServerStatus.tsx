import { useEffect, useState } from 'react';
import { onServerStatus, type ServerStatus } from '../lib/api';

/** Fixed, polite banner shown while the free-tier server is waking up or unreachable. Renders nothing when all is well. */
export function ServerStatusBanner() {
  const [s, setS] = useState<ServerStatus>('ok');
  useEffect(() => onServerStatus(setS), []);
  if (s === 'ok') return null;
  const waking = s === 'waking';
  return (
    <div role="status" aria-live="polite" className="fixed inset-x-0 top-0 z-50 flex justify-center p-3 pointer-events-none">
      <div className={`pointer-events-auto max-w-xl rounded-2xl border-2 px-5 py-3 shadow-lg text-lg ${waking ? 'bg-amber-soft border-amber' : 'bg-danger-soft border-danger'}`}>
        {waking ? (
          <p><strong>Waking up the server…</strong> SaySafe runs on a free server that sleeps when nobody is using it. This can take up to a minute. Your purchases and approvals are safe.</p>
        ) : (
          <p>
            <strong>We can't reach SaySafe right now.</strong> We'll keep trying. Nothing has been charged.{' '}
            <button type="button" className="underline font-semibold" onClick={() => window.location.reload()}>Try again</button>
          </p>
        )}
      </div>
    </div>
  );
}
