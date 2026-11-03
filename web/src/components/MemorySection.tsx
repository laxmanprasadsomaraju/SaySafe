/**
 * Profile → "What SaySafe remembers", in two clearly separate parts:
 *  (b) Long-term memory: preferences Mary states. ON by default; turn off, see, edit or remove each item, clear all.
 *      Demo sample items are labelled "Sample".
 *  (a) Recent conversation (short-term): last 10 turns + 20 products shown, 14 days, kept even when memory is off,
 *      used only to understand "that one"; "Clear recent conversation" deletes it.
 * Elder only. Values are shown as plain text (React escapes them).
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { btnSecondary, btnDanger, linkBtn, switchBtn, input } from './ds';
import { THREAD_KEY } from '../assistant/thread';

interface MemoryItem { id: string; category: string; key: string; value: string; source: 'voice' | 'text' | 'profile'; label: string; updatedAt: string; sample?: boolean }
interface Snapshot { enabled: boolean; items: MemoryItem[]; context: { turns: number; products: { title: string }[]; keptDays: number }; why: string }
const SOURCE: Record<MemoryItem['source'], string> = { voice: 'you said it', text: 'you typed it', profile: 'you edited it' };

export function MemoryBody() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [why, setWhy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => { setErr(null); api<Snapshot>('/api/memory').then(setSnap).catch((e) => setErr(e?.message || 'Something went wrong.')); };
  useEffect(load, []);
  const run = async (fn: () => Promise<unknown>, done?: string) => { setMsg(null); try { await fn(); load(); if (done) setMsg(done); } catch (e: any) { setErr(e?.message || 'Something went wrong.'); } };

  if (err) return (
    <div role="alert" data-testid="memory-error">
      <p className="font-bold text-danger">Couldn’t load what SaySafe remembers: {err}</p>
      <button type="button" onClick={load} className={`mt-3 ${btnSecondary}`}>Retry</button>
    </div>
  );
  if (!snap) return <p className="text-ink-soft" role="status">Loading…</p>;
  const ctxCount = snap.context.products.length;
  return (
    <div data-testid="memory-section">
      <h4 className="font-bold text-navy" id="mem-long-h">Your preferences (long-term memory)</h4>
      <div className="flex items-center justify-between gap-4 py-1">
        <span className="min-w-0"><span className="block font-bold" id="mem-on-l">Remember my preferences</span><span className="block text-base text-ink-soft" id="mem-on-h">On unless you turn it off. Only shopping preferences you clearly tell me, like a colour, a brand or a budget.</span></span>
        <button type="button" role="switch" aria-checked={snap.enabled} aria-labelledby="mem-on-l" aria-describedby="mem-on-h" className={switchBtn(snap.enabled)}
          onClick={() => run(() => api('/api/memory/settings', { method: 'PUT', body: { enabled: !snap.enabled } }), snap.enabled ? 'Memory is off. Nothing new will be saved, and saved preferences are not used.' : 'Memory is on. Tell me, for example, “I prefer red”.')}>{snap.enabled ? 'On' : 'Off'}</button>
      </div>
      {!snap.enabled && <p className="mt-1 text-base" data-testid="memory-off-note">Memory is off: nothing new is saved and your saved preferences are not used. The recent conversation below is still kept for {snap.context.keptDays} days.</p>}
      {snap.items.length > 0 ? (
        <ul className="mt-2 divide-y divide-line" aria-label="Things SaySafe remembers">
          {snap.items.map((m) => (
            <li key={m.id} className="py-2">
              {editing?.id === m.id ? (
                <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); const v = editing.value.trim(); if (v) void run(() => api(`/api/memory/${m.id}`, { method: 'PATCH', body: { value: v } }), 'Saved.').then(() => setEditing(null)); }}>
                  <label className="sr-only" htmlFor={`mem-${m.id}`}>Change “{m.label}”</label>
                  <input id={`mem-${m.id}`} className={`${input} flex-1`} maxLength={120} value={editing.value} onChange={(e) => setEditing({ id: m.id, value: e.target.value })} />
                  <button type="submit" className={btnSecondary}>Save</button>
                  <button type="button" className={linkBtn} onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0"><span className="block font-bold">{m.sample && <span className="mr-2 inline-block rounded-full border border-line bg-paper px-2 py-0.5 text-sm font-bold text-ink-soft align-middle" data-testid="memory-sample-badge">Sample</span>}{m.label}</span><span className="block text-sm text-ink-soft">{m.sample ? 'demo sample — change or remove it' : SOURCE[m.source]}</span></span>
                  <span className="flex gap-2">
                    <button type="button" className={btnSecondary} aria-label={`Change ${m.label}`} onClick={() => setEditing({ id: m.id, value: m.value })}>Change</button>
                    <button type="button" className={btnSecondary} aria-label={`Remove ${m.label}`} onClick={() => run(() => api(`/api/memory/${m.id}`, { method: 'DELETE' }), 'Removed.')}>Remove</button>
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-base text-ink-soft">{snap.enabled ? 'Nothing saved yet. Say, for example, “I don’t like Breville” or “keep my budget below €100”.' : 'Nothing saved.'}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className={linkBtn} aria-expanded={why} onClick={() => setWhy(!why)}>Why are results personalised?</button>
        {confirmClear ? (
          <span className="flex flex-wrap gap-2">
            <button type="button" className={btnDanger} onClick={() => run(() => api('/api/memory', { method: 'DELETE', body: { confirm: true } }), 'Cleared.').then(() => setConfirmClear(false))}>Yes, clear all</button>
            <button type="button" className={btnSecondary} onClick={() => setConfirmClear(false)}>Keep</button>
          </span>
        ) : <button type="button" className={btnSecondary} onClick={() => setConfirmClear(true)}>Clear all memory</button>}
      </div>
      {why && <p className="mt-2 text-base">{snap.why}</p>}
      <div className="mt-4 border-t border-line pt-3" data-testid="memory-context">
        <h4 className="font-bold text-navy">Recent conversation (short-term)</h4>
        <p className="mt-1 text-base text-ink-soft">SaySafe keeps your last {10} messages and the last {20} products it showed you, for {snap.context.keptDays} days, only so “that one” or “the cheaper one” makes sense later. This is kept even when memory is off. It is never proof of a payment.</p>
        <p className="mt-1 text-base">Now: {ctxCount ? `${ctxCount} product${ctxCount > 1 ? 's' : ''} you looked at` : 'nothing yet'}.</p>
        <button type="button" className={`mt-2 ${btnSecondary}`} onClick={() => run(async () => { try { sessionStorage.removeItem(THREAD_KEY); } catch { /* */ } await api('/api/memory', { method: 'DELETE', body: { confirm: true, scope: 'context' } }); }, 'Recent conversation cleared. Your preferences are kept.')}>Clear recent conversation</button>
      </div>
      {msg && <p className="mt-2 text-base font-bold" role="status">{msg}</p>}
    </div>
  );
}
