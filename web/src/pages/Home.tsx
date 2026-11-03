import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquareWarning, ShoppingBag, LifeBuoy, Keyboard, ChevronRight, Clock, Store } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Card, MicButton, Caption, Button } from '../components/ui';
import { api, eur, type PaymentRequest } from '../lib/api';
import { speech, useVoiceInput } from '../lib/voice';
import { useMe } from '../lib/session';
import { normaliseLang } from '../../../shared/lang';
import { stateLabel } from './Order';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const me = useMe('elder');
  const nav = useNavigate();
  const [caption, setCaption] = useState<string | null>(null);
  const [captionLang, setCaptionLang] = useState<string | undefined>();
  const [typed, setTyped] = useState('');
  const [showType, setShowType] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<PaymentRequest[]>([]);
  useEffect(() => { if (me) api<PaymentRequest[]>('/api/payments').then(setRecent).catch(() => {}); }, [me]);

  const handle = useCallback(async (text: string) => {
    setBusy(true);
    setCaption(`You said: “${text}”`); setCaptionLang(undefined);
    const turn = speech.beginTurn();
    try {
      const r = await api('/api/assistant', { body: { text, step: 'home' } });
      if (!speech.isCurrent(turn)) return; // a newer request, Stop, or navigation happened: ignore this reply
      const a = r.intent.action;
      if (r.discover && !r.discover.suggested) { nav('/discover', { state: { query: r.discover.query } }); return; }
      if (a === 'shop') { nav('/shop', { state: { query: text, result: r } }); return; }
      if (a === 'check_message') { nav('/check', { state: { text: r.intent.message_text && r.intent.message_text !== text ? r.intent.message_text : '' } }); return; }
      if (a === 'trusted_help' || a === 'order_problem') { nav('/help', { state: { problem: a === 'order_problem' } }); return; }
      setCaption(r.reply); setCaptionLang(r.replyLang); speech.speak(r.reply, { turn, lang: normaliseLang(r.replyLang) });
    } catch (e: any) { if (speech.isCurrent(turn)) setCaption(e.message); }
    finally { setBusy(false); speech.endThinking(); }
  }, [nav]);
  const voice = useVoiceInput(handle);

  const actions = [
    { to: '/check', icon: MessageSquareWarning, title: 'Check a message', text: 'Is this text, email or link really from PayPal?' },
    { to: '/shop', icon: ShoppingBag, title: 'Shop by voice', text: 'Find something and pay safely with PayPal.' },
    { to: '/discover', icon: Store, title: 'Compare real shops', text: 'Listings found for Ireland (EUR). You buy on the shop’s own site.' },
    { to: '/help', icon: LifeBuoy, title: 'Get trusted help', text: 'Official PayPal help, order problems, or your family.' },
  ];
  if (!me) return <Layout><p>Loading…</p></Layout>;
  return (
    <Layout>
      <header className="text-center fade-up">
        <h1 className="text-[length:var(--text-hero)]">{greeting()}, {me.name}.</h1>
        <p className="mt-2 text-[length:var(--text-lead)] text-ink-soft">What would you like to do today?</p>
      </header>
      <div className="mt-8 flex flex-col items-center gap-4">
        <MicButton state={voice.state} onClick={voice.toggle} label="Tap and tell me" />
        {voice.state === 'unsupported' || voice.error || showType ? null : (
          <button className="inline-flex items-center gap-2 text-teal font-bold underline underline-offset-4 min-h-12" onClick={() => setShowType(true)}><Keyboard className="size-5" aria-hidden />Type instead</button>
        )}
        {voice.error && <p role="alert" className="text-danger font-bold text-center max-w-lg">{voice.error}</p>}
        {(showType || voice.state === 'unsupported' || voice.error) && (
          <form className="w-full max-w-xl flex gap-3" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) handle(typed.trim()); }}>
            <label htmlFor="ask" className="sr-only">Type what you need</label>
            <input id="ask" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="e.g. find a kettle under €40" className="flex-1 min-h-14 rounded-full border-2 border-line px-6 bg-paper focus:border-teal outline-none" />
            <Button type="submit" busy={busy}>Ask</Button>
          </form>
        )}
        <div className="w-full max-w-xl"><Caption text={caption} lang={captionLang} /></div>
      </div>

      <nav aria-label="Main actions" className="mt-10 grid md:grid-cols-2 gap-5">
        {actions.map(({ to, icon: Icon, title, text }) => (
          <button key={to} onClick={() => nav(to)} className="group text-left bg-paper rounded-[var(--radius-card)] border-2 border-line hover:border-teal shadow-[var(--shadow-card)] p-6 min-h-44 flex flex-col">
            <span className="size-14 rounded-2xl bg-teal-soft grid place-items-center"><Icon className="size-8 text-teal" aria-hidden /></span>
            <span className="font-display text-[1.65rem] font-semibold mt-4 flex items-center justify-between">{title}<ChevronRight className="size-7 text-teal group-hover:translate-x-1 transition-transform" aria-hidden /></span>
            <span className="text-ink-soft text-lg mt-1">{text}</span>
          </button>
        ))}
      </nav>

      {recent.length > 0 && (
        <Card className="mt-10 p-6">
          <h2 className="text-2xl flex items-center gap-2"><Clock className="size-6 text-teal" aria-hidden />Your recent purchases</h2>
          <ul className="mt-4 divide-y divide-line">
            {recent.slice(0, 4).map((r) => (
              <li key={r.id}>
                <button onClick={() => nav(`/order/${r.id}`)} className="w-full flex flex-wrap justify-between gap-2 py-4 text-left hover:text-teal min-h-14">
                  <span className="font-bold">{r.items.map((i) => i.name).join(', ')}</span>
                  <span className="text-ink-soft">{eur(r.amountCents)} · {stateLabel(r.state)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Layout>
  );
}
