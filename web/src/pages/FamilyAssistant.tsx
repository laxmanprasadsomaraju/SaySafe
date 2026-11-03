/**
 * Alex's (trusted family member's) Assistant. It shows purchases waiting for a review as cards with the exact items
 * and amount from the server, and the household history with search. Approve / Decline call the existing family
 * decision endpoint, which checks role, household, the exact basket (fingerprint) and expiry. Nothing here can pay:
 * the elder always approves at PayPal. Intents are deterministic (no AI) and only choose which card to show.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, SendHorizontal, ShieldCheck } from 'lucide-react';
import { Layout } from '../components/Layout';
import { api } from '../lib/api';
import { fetchActivity } from '../lib/activity';
import { AssistantHeader } from '../assistant/AssistantHeader';
import { RenderBlock, type BlockActions } from '../assistant/blocks';
import { FAMILY_THREAD_KEY } from '../assistant/thread';
import { isCompanionKind } from '../assistant/companion';
import { parseBlock, restoreThread, ServerPayment, ServerActivity, parseServer, familyReviewFrom, historyFrom, type Block, type Message, type Thread } from '../assistant/schemas';

const mid = () => Math.random().toString(36).slice(2, 10);
const HELLO = 'I show purchases waiting for your review and the household’s history. You can’t pay from their account: they always approve at PayPal.';
const fresh = (): Thread => ({ v: 1, mode: 'chat', focusId: null, messages: [{ id: mid(), role: 'assistant', text: HELLO, blocks: [] }] });
// The elder's payment companion cards are private to her: never restored, added or shown in the family view.
const load = (): Thread => { try { return restoreThread(sessionStorage.getItem(FAMILY_THREAD_KEY), { drop: (b) => isCompanionKind(b.kind) }) ?? fresh(); } catch { return fresh(); } };
const CHIPS = ['What’s waiting for me?', 'Show history'];

interface Overview { elder: { name: string | null }; requests: unknown[] }

export default function FamilyAssistant() {
  const nav = useNavigate();
  const [thread, setThread] = useState<Thread>(load);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const threadRef = useRef(thread); threadRef.current = thread;
  useEffect(() => { try { sessionStorage.setItem(FAMILY_THREAD_KEY, JSON.stringify(thread)); } catch { /* */ } }, [thread]);

  const add = useCallback((role: Message['role'], text: string, blocks: unknown[] = []) => {
    const valid = blocks.map(parseBlock).filter((b): b is Block => b !== null && !isCompanionKind(b.kind));
    setThread((t) => ({ ...t, messages: [...t.messages, { id: mid(), role, text: text.slice(0, 4000), blocks: valid }].slice(-80) }));
  }, []);
  const shownIds = () => new Set(threadRef.current.messages.flatMap((m) => m.blocks).filter((b) => b.kind === 'family_review').map((b) => (b as { requestId: string }).requestId));

  /** Pending reviews from the server (validated). `onlyNew` adds only requests not already in the conversation. */
  const showWaiting = async (onlyNew = false) => {
    const o = await api<Overview>('/api/family/overview');
    const elderName = typeof o?.elder?.name === 'string' ? o.elder.name.slice(0, 40) : null;
    const rows = (Array.isArray(o?.requests) ? o.requests : []).map((r) => ServerPayment.safeParse(r)).filter((r) => r.success).map((r) => r.data!);
    const waiting = rows.filter((r) => r.state === 'FAMILY_APPROVAL_PENDING' && r.approval?.status === 'pending' && r.approval.expiresAt > Date.now());
    const seen = shownIds();
    const list = (onlyNew ? waiting.filter((r) => !seen.has(r.id)) : waiting).slice(0, 3);
    const blocks = list.map((r) => familyReviewFrom({ ...r, elderName })).filter(Boolean);
    if (onlyNew && !blocks.length) return;
    const who = elderName ?? 'Your relative';
    const text = blocks.length ? `${who} asked you to check ${blocks.length === 1 ? 'this purchase' : `${blocks.length} purchases`}. Approve only if the item and price look right.` : 'Nothing is waiting for you right now.';
    // One card per message keeps each review easy to find and to read aloud.
    if (blocks.length <= 1) add('assistant', text, blocks);
    else { add('assistant', text); blocks.forEach((b) => add('assistant', '', [b])); }
  };
  const showHistory = async (q?: string) => {
    const a = parseServer(ServerActivity, await fetchActivity({ as: 'family', limit: 5, q }));
    add('assistant', q ? (a.total ? `I found ${a.total} for “${q}”.` : `Nothing matches “${q}”.`) : 'Here is the household’s recent activity. Search for an item if you need to.', [historyFrom(a, q, 'family')]);
  };

  useEffect(() => {
    let off = false;
    api<{ family: { name: string } | null }>('/api/me').then((m) => {
      if (off) return;
      if (!m.family) { nav('/family/pair', { replace: true }); return; }
      setReady(true);
      void showWaiting(threadRef.current.messages.length > 1).catch(() => {});
    }).catch(() => setReady(true));
    return () => { off = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // New requests appear while the Assistant is open (checked every 8 s; never stacks requests).
  useEffect(() => {
    if (!ready) return;
    let inFlight = false;
    const t = setInterval(() => { if (inFlight) return; inFlight = true; showWaiting(true).catch(() => {}).finally(() => { inFlight = false; }); }, 8000);
    return () => clearInterval(t);
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.querySelector('[role="log"] > div:last-of-type')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [thread.messages.length]);

  const handle = async (raw: string) => {
    const text = raw.trim(); if (!text) return;
    add('user', text); setInput(''); setBusy(true);
    try {
      const s = text.toLowerCase();
      const q = s.match(/^(?:search|find|look for)\s+(?:history\s+|activity\s+)?(?:for\s+)?(.{2,60})$/)?.[1];
      if (q) await showHistory(q.replace(/[?.!]+$/, ''));
      else if (/\b(history|activity|purchases|payments|bought)\b/.test(s)) await showHistory();
      else if (/\b(wait|waiting|review|pending|approve|decline|check|request)\b/.test(s)) await showWaiting();
      else add('assistant', 'I can show what’s waiting for your review, or the household’s history. Try one of the buttons below.');
    } catch (e: any) { add('assistant', e.message || 'Something went wrong. Nothing was changed.'); }
    finally { setBusy(false); }
  };
  const act: BlockActions = {
    audience: 'family',
    openItem: () => {}, compare: () => {}, allow: () => {}, deny: () => {}, share: () => {}, receipt: () => {}, refund: () => {},
    replace: (old, next) => {
      const ok = parseBlock(next); if (!ok) return;
      setThread((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, blocks: m.blocks.map((b) => (b === old || (b.kind === ok.kind && ok.kind !== 'payment_history' && 'requestId' in b && 'requestId' in ok && b.requestId === ok.requestId) ? ok : b)) })) }));
    },
  };

  const composer = (
    <div className="mx-auto max-w-5xl px-3 sm:px-5 py-2">
      <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void handle(input); }}>
        <label htmlFor="family-input" className="sr-only">Message SaySafe</label>
        <input id="family-input" value={input} maxLength={200} onChange={(e) => setInput(e.target.value)} placeholder="e.g. what’s waiting?" className="flex-1 min-w-0 min-h-12 rounded-3xl border-2 border-line bg-paper px-4 focus:border-teal outline-none" />
        <button type="submit" disabled={busy || !input.trim()} className="min-h-12 shrink-0 rounded-full bg-navy text-white inline-flex items-center gap-2 px-4 font-bold disabled:opacity-40"><SendHorizontal className="size-5" aria-hidden />Send</button>
      </form>
    </div>
  );
  return (
    <Layout mode="family" dock={composer} footer={false}>
      <AssistantHeader voice={false} onNew={() => { setThread(fresh()); setTimeout(() => void showWaiting().catch(() => {}), 0); }} />
      <p className="mt-1 text-base text-ink-soft flex items-start gap-2"><ShieldCheck className="size-5 text-teal shrink-0 mt-0.5" aria-hidden />You review bigger purchases. Payments use the PayPal Sandbox (no real money).</p>
      <div role="log" aria-live="polite" aria-label="Conversation" className="mt-4 flex flex-col gap-3">
        {thread.messages.map((m) => (
          <div key={m.id} data-role={m.role} className={`scroll-mt-24 ${m.role === 'user' ? 'self-end max-w-[85%]' : 'self-start w-full max-w-2xl'}`}>
            {m.text && <p className={`rounded-3xl px-4 py-3 break-words whitespace-pre-wrap ${m.role === 'user' ? 'bg-navy text-white rounded-br-lg' : 'bg-teal-soft text-navy rounded-bl-lg'}`}><span className="sr-only">{m.role === 'user' ? 'You: ' : 'SaySafe: '}</span>{m.text}</p>}
            {m.blocks.map((b, i) => <div key={i} className="mt-2"><RenderBlock b={b} act={act} /></div>)}
          </div>
        ))}
        {busy && <p className="self-start rounded-3xl bg-teal-soft px-4 py-3 text-ink-soft inline-flex items-center gap-2"><Loader2 className="size-5 motion-safe:animate-spin" aria-hidden />Checking…</p>}
      </div>
      {!busy && (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Suggestions">
          {CHIPS.map((c) => <button key={c} type="button" onClick={() => void handle(c)} className="min-h-12 px-4 rounded-full border-2 border-teal text-teal-deep bg-paper font-bold">{c}</button>)}
        </div>
      )}
    </Layout>
  );
}
