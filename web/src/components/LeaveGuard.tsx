/**
 * Asks before leaving a screen with a purchase still waiting (family review, PayPal approval, or an
 * unanswered Allow/Deny card). Leaving NEVER cancels anything: the purchase stays saved in Activity.
 * Covers in-app links, the tab bar, the Back button and the browser's Back button (react-router blocker).
 */
import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { handoffActive } from '../lib/handoff';

const ACK = 'ss-leave-ack';
const acked = (id: string) => { try { return (JSON.parse(sessionStorage.getItem(ACK) ?? '[]') as string[]).includes(id); } catch { return false; } };
const ack = (id: string) => { try { const a = JSON.parse(sessionStorage.getItem(ACK) ?? '[]') as string[]; sessionStorage.setItem(ACK, JSON.stringify([...a, id].slice(-50))); } catch { /* */ } };

export function LeaveGuard({ when, id, title, detail }: { when: boolean; id: string; title: string; detail: string }) {
  const active = when && !acked(id);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => active && !handoffActive() && currentLocation.pathname !== nextLocation.pathname);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (blocker.state === 'blocked' && !d.open) d.showModal?.();
    if (blocker.state !== 'blocked' && d.open) d.close();
  }, [blocker.state]);
  if (blocker.state !== 'blocked') return null;
  return (
    <dialog ref={ref} aria-labelledby={`lg-${id}`} aria-describedby={`lgd-${id}`} onCancel={(e) => { e.preventDefault(); blocker.reset?.(); }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[var(--radius-card)] border-2 border-amber bg-paper p-6 text-navy backdrop:bg-navy/50">
      <h2 id={`lg-${id}`} className="text-2xl flex items-center gap-2"><Clock className="size-7 text-amber shrink-0" aria-hidden />{title}</h2>
      <p id={`lgd-${id}`} className="mt-3 text-lg">{detail} Leaving won’t cancel it. You’ll find it in Activity.</p>
      <div className="mt-5 flex flex-col sm:flex-row gap-3">
        <button type="button" autoFocus onClick={() => blocker.reset?.()} className="min-h-14 px-6 rounded-full bg-teal text-white font-bold">Stay here</button>
        <button type="button" onClick={() => { ack(id); blocker.proceed?.(); }} className="min-h-14 px-6 rounded-full border-2 border-line font-bold hover:border-teal">Leave, keep it saved</button>
      </div>
    </dialog>
  );
}
