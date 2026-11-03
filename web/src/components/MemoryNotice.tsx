/**
 * One-time notice in the Assistant: long-term memory is ON by default, so say so plainly the first time Mary
 * opens the Assistant on this device (and only while memory is on). Dismissed with "OK" or by leaving; never shown again
 * on this device. Elder only (the Assistant is elder only).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Brain } from 'lucide-react';
import { api } from '../lib/api';

export const MEMORY_NOTICE_KEY = 'ss-memory-notice-v1';
export const MEMORY_NOTICE_TEXT = 'SaySafe remembers shopping preferences you tell it, like colours or budget. You can see, change or turn this off in Profile.';

export function MemoryNotice() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let seen = false;
    try { seen = localStorage.getItem(MEMORY_NOTICE_KEY) === '1'; } catch { /* private mode: show once per visit */ }
    if (seen) return;
    let live = true;
    api<{ enabled: boolean }>('/api/memory').then((s) => {
      if (!live || !s?.enabled) return;
      setShow(true);
      try { localStorage.setItem(MEMORY_NOTICE_KEY, '1'); } catch { /* */ }
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!show) return null;
  return (
    <div role="note" aria-label="About memory" data-testid="memory-notice" className="mt-2 flex flex-wrap items-start gap-3 rounded-2xl border-2 border-line bg-paper px-4 py-3">
      <Brain className="size-5 text-teal shrink-0 mt-1" aria-hidden />
      <p className="min-w-0 flex-1 text-base">{MEMORY_NOTICE_TEXT} <Link className="font-bold text-teal-deep underline" to="/profile#memory-h">Open Profile</Link></p>
      <button type="button" onClick={() => setShow(false)} className="min-h-11 px-4 rounded-full border-2 border-navy bg-navy text-white font-bold">OK</button>
    </div>
  );
}
