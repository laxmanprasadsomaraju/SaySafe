/**
 * Profile → "What SaySafe remembers": turn memory on/off, see, edit or remove each item, clear all,
 * and a plain-language "why personalised". Elder only. Values are shown as plain text (React escapes them).
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { btnSecondary, btnDanger, linkBtn, switchBtn, input } from './ds';

interface MemoryItem { id: string; category: string; key: string; value: string; source: 'voice' | 'text' | 'profile'; label: string; updatedAt: string }
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
      <div className="flex items-center justify-between gap-4 py-1">
        <span className="min-w-0"><span className="block font-bold" id="mem-on-l">Remember my preferences</span><span className="block text-base text-ink-soft" id="mem-on-h">Off unless you turn it on. Only shopping preferences you clearly tell me.</span></span>
        <button type="button" role="switch" aria-checked={snap.enabled} aria-labelledby="mem-on-l" aria-describedby="mem-on-h" className={switchBtn(snap.enabled)}
          onClick={() => run(() => api('/api/memory/settings', { method: 'PUT', body: { enabled: !snap.enabled } }), snap.enabled ? 'Memory is off. Nothing new will be saved.' : 'Memory is on. Tell me, for example, “I prefer red”.')}>{snap.enabled ? 'On' : 'Off'}</button>
      </div>
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
                  <span className="min-w-0"><span className="block font-bold">{m.label}</span><span className="block text-sm text-ink-soft">{SOURCE[m.source]}</span></span>
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
      <p className="mt-2 text-base text-ink-soft">Recent conversation: {ctxCount ? `${ctxCount} product${ctxCount > 1 ? 's' : ''} you looked at` : 'nothing yet'}, kept {snap.context.keptDays} days so “that microwave” still makes sense later. It is never proof of a payment.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className={linkBtn} aria-expanded={why} onClick={() => setWhy(!why)}>Why are results personalised?</button>
        {confirmClear ? (
          <span className="flex flex-wrap gap-2">
            <button type="button" className={btnDanger} onClick={() => run(() => api('/api/memory', { method: 'DELETE', body: { confirm: true } }), 'Cleared.').then(() => setConfirmClear(false))}>Yes, clear all</button>
            <button type="button" className={btnSecondary} onClick={() => setConfirmClear(false)}>Keep</button>
          </span>
        ) : <button type="button" className={btnSecondary} onClick={() => setConfirmClear(true)}>Clear all</button>}
      </div>
      {why && <p className="mt-2 text-base">{snap.why}</p>}
      {msg && <p className="mt-2 text-base font-bold" role="status">{msg}</p>}
    </div>
  );
}
