import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Search, ExternalLink, Info, Store, Star, Columns3, SlidersHorizontal } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, Card, PageTitle, MicButton, Caption, Notice, LinkButton } from '../components/ui';
import { ReadAloud } from '../components/VoiceBar';
import { api } from '../lib/api';
import { speech, useVoiceInput, useSpeech } from '../lib/voice';
import { useMe } from '../lib/session';
import { loadProfile, localProfileForRequest } from '../lib/prefs';
import {
  parseFollowup, parseRequest, recommend, spokenRecommendation, readAllSegments, describeItem, specsAnswer, compareRows, shortTitle,
  profileIsEmpty, EMPTY_PROFILE, type ShopItem, type Recommendation, type PickRole, type ShoppingProfile,
} from '../../../shared/shopping';

interface Result {
  source: 'channel3'; query: string; searchQuery: string; maxPrice: number | null; currency: string; fetchedAt: string;
  products: ShopItem[]; recommendation: Recommendation; explanation: string | null; profileApplied: boolean; reply: string;
}

const money = (n: number, c: string) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: c }).format(n);
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' });
const ROLE: Record<PickRole, string> = { best: 'Best match', cheaper: 'Lower-cost alternative', another: 'Another option' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function Discover() {
  const me = useMe('elder');
  const loc = useLocation() as { state?: { query?: string } };
  const voiceState = useSpeech();
  const [query, setQuery] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [caption, setCaption] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [profile, setProfile] = useState<ShoppingProfile>(EMPTY_PROFILE);
  const compareRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  useEffect(() => { loadProfile().then((r) => setProfile(r.profile)).catch(() => {}); }, []);

  const byId = useMemo(() => new Map((res?.products ?? []).map((p) => [p.id, p])), [res]);
  const picks = res?.recommendation.picks ?? [];
  const pickItems = picks.map((p) => byId.get(p.id)!).filter(Boolean);
  const others = (res?.products ?? []).filter((p) => !picks.some((k) => k.id === p.id));

  const say = (text: string, turn?: number) => { setCaption(text); speech.speak(text, { turn }); };

  const speakResults = (r: Result, turn: number) => {
    setCaption(r.reply);
    if (speech.getSnapshot().prefs.readAll && r.products.length) speech.speak([r.reply, ...readAllSegments(r.products)], { priority: 'list', turn });
    else speech.speak(r.reply, { turn });
  };

  const search = async (text: string, maxPrice?: number, label?: string) => {
    const turn = speech.beginTurn();
    setBusy(true); setErr(null);
    try {
      const r = await api<Result>('/api/discover', { body: { text, maxPrice: maxPrice ?? null, profile: localProfileForRequest() } });
      if (!speech.isCurrent(turn)) return; // user navigated, stopped, or asked something else meanwhile
      if (label && r.products.length === 0) { const msg = `${label}, I found no other listings for ${r.searchQuery}.`; setCaption(msg); speech.speak(msg, { turn }); return; }
      setRes(r); setCompare([]);
      speakResults(r, turn);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); speech.endThinking(); }
  };

  /** Re-rank the results we already have (e.g. "show only under €100") without a new search. */
  const rerankLocally = (max: number): boolean => {
    if (!res) return false;
    const items = res.products.filter((p) => p.offers[0].price <= max);
    if (!items.length) return false;
    const req = { ...parseRequest(res.searchQuery), budget: { max, min: null } };
    const rec = recommend(items, req, profile);
    const ranked = rec.rankedIds.map((id) => items.find((p) => p.id === id)!);
    const next: Result = { ...res, maxPrice: max, products: ranked, recommendation: rec, explanation: null, reply: spokenRecommendation(ranked, rec, res.searchQuery) };
    setRes(next); setCompare([]);
    const turn = speech.beginTurn();
    speakResults(next, turn);
    speech.endThinking();
    return true;
  };

  const ask = async (text: string) => {
    setCaption(`You said: “${text}”`);
    const f = parseFollowup(text, Boolean(res?.products.length));
    const pickAt = (i: number) => { const k = picks[i]; return k ? { k, p: byId.get(k.id)! } : null; };
    switch (f.kind) {
      case 'stop': speech.stop(); setCaption('Stopped.'); return;
      case 'why': {
        const x = pickAt(f.index ?? 0);
        if (!x) return say("There's no option there. The best match is first.");
        const reasons = x.k.reasons.slice(0, 2).join(', and ');
        return say(x.k.role === 'best' && res?.explanation ? res.explanation : `I suggested the ${shortTitle(x.p.title)} because ${reasons}.`, speech.beginTurn());
      }
      case 'more': {
        const x = pickAt(f.index);
        if (!x) return say("There's no option there.");
        return say(describeItem(x.p, ROLE[x.k.role]), speech.beginTurn());
      }
      case 'specs': {
        setCompare(pickItems.map((p) => p.id));
        setTimeout(() => compareRef.current?.focus(), 50);
        return say(specsAnswer(pickItems, pickItems.map((p) => shortTitle(p.title))), speech.beginTurn());
      }
      case 'cheaper': {
        // Stop talking and ask Channel3 again: same product words (same category), strictly below the best match's price.
        const best = pickItems[0];
        if (!best) return search(res!.searchQuery);
        const cap = Math.round((best.offers[0].price - 0.01) * 100) / 100;
        return search(res!.searchQuery, cap, `Cheaper than ${money(best.offers[0].price, best.offers[0].currency)}`);
      }
      case 'budget':
        if (rerankLocally(f.max)) return;
        return search(res!.searchQuery, f.max);
      default:
        return search(f.text);
    }
  };
  const voice = useVoiceInput(ask);

  useEffect(() => {
    if (started.current || !me || !loc.state?.query) return;
    started.current = true; setQuery(loc.state.query); ask(loc.state.query);
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleCompare = (id: string) => setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id].slice(-3)));
  const compareItems = compare.map((id) => byId.get(id)).filter(Boolean) as ShopItem[];

  if (!me) return <Layout><p>Loading…</p></Layout>;
  return (
    <Layout>
      <PageTitle eyebrow="Find real products" title="Compare real shops" lead="Say or type what you need, for example: “Find me a microwave under €150.” I search listings found for Ireland (EUR) and show you where to buy." />
      <Notice tone="info" title="You buy on the shop’s own website">
        These listings come from other shops, found with Channel3. SaySafe doesn’t sell them or take payment for them. Family Circle checks and the SaySafe sandbox checkout don’t cover them.
      </Notice>
      <div className="mt-8 grid grid-cols-1 md:grid-cols-[auto_1fr] gap-8 items-center">
        <MicButton state={voice.state} onClick={voice.toggle} />
        <div className="space-y-4 min-w-0">
          <form className="flex flex-wrap gap-3" onSubmit={(e) => { e.preventDefault(); if (query.trim()) ask(query.trim()); }}>
            <label htmlFor="dq" className="sr-only">Type what you are looking for, or ask about the results</label>
            <input id="dq" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type it here instead" className="flex-1 min-w-[12rem] min-h-14 rounded-full border-2 border-line px-6 bg-paper focus:border-teal outline-none" />
            <Button type="submit" busy={busy} icon={<Search className="size-6" aria-hidden />}>Search</Button>
          </form>
          {voice.error && <p role="alert" className="text-danger font-bold">{voice.error}</p>}
          {res && res.products.length > 0 && <p className="text-base text-ink-soft">You can also ask: “Why this one?”, “Find something cheaper”, “Which has better specifications?”, “Show only under €100”, “Tell me more about the second one”.</p>}
          <Caption text={caption} />
          <p className="text-base text-ink-soft flex flex-wrap items-center gap-x-3">
            <SlidersHorizontal className="size-5" aria-hidden />
            {profileIsEmpty(profile) ? 'No shopping preferences saved.' : 'Using your shopping preferences.'}
            <Link to="/preferences" className="font-bold text-teal underline underline-offset-4 min-h-11 inline-flex items-center">My preferences</Link>
            {voiceState.prefs.readAll && <span className="font-bold text-amber">Read everything is on</span>}
          </p>
        </div>
      </div>

      {err && <div className="mt-6"><Notice tone="danger" title={err} /></div>}

      {res && res.products.length === 0 && (
        <div className="mt-8"><Notice tone="info" title="No matching listings">{res.reply} You can also try the SaySafe Demo Shop.</Notice></div>
      )}

      {res && res.products.length > 0 && (
        <section aria-label="Recommended listings" className="mt-10">
          <p className="text-base text-ink-soft flex items-start gap-2"><Info className="size-5 shrink-0 mt-0.5" aria-hidden />
            <span>Found with Channel3 at {time(res.fetchedAt)}, prices in {res.currency}{res.maxPrice ? ` up to ${money(res.maxPrice, res.currency)}` : ''}. Prices and stock come from the retailer listing and can change. SaySafe hasn’t checked these shops.
              {res.recommendation.usedProfileBudget !== null && ` Your usual budget of ${money(res.recommendation.usedProfileBudget, res.currency)} was applied.`}
              {res.recommendation.profileBudgetRelaxed && ' Nothing was within your usual budget, so it wasn’t applied.'}
              {res.recommendation.avoidedCount > 0 && ` ${res.recommendation.avoidedCount} listing${res.recommendation.avoidedCount > 1 ? 's were' : ' was'} hidden because ${res.recommendation.avoidedCount > 1 ? 'they mention' : 'it mentions'} something on your avoid list.`}
            </span></p>
          <ul className="mt-5 grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {picks.map((k) => {
              const p = byId.get(k.id); if (!p) return null;
              const o = p.offers[0];
              const titleId = `t-${p.id}`;
              return (
                <li key={k.id}>
                  <Card as="article" aria-labelledby={titleId} className={`overflow-hidden flex flex-col h-full ${k.role === 'best' ? 'border-2 border-teal' : ''}`}>
                    <div className="aspect-[4/3] bg-white grid place-items-center">
                      {p.image ? <img src={p.image} alt={p.imageAlt} className="max-h-full max-w-full object-contain p-3" loading="lazy" referrerPolicy="no-referrer" /> : <Store className="size-12 text-ink-soft" aria-label="No photo available" />}
                    </div>
                    <div className="p-5 flex flex-col flex-1">
                      <p className={`text-sm font-bold uppercase tracking-wider ${k.role === 'best' ? 'text-teal' : 'text-ink-soft'}`}>{ROLE[k.role]}{p.brand ? ` · ${p.brand}` : ''}</p>
                      <h2 id={titleId} className="text-[1.3rem] mt-1 leading-snug break-words">{p.title}</h2>
                      <p className="mt-2 flex flex-wrap items-baseline gap-x-2"><span className="font-display text-3xl font-semibold">{money(o.price, o.currency)}</span>{o.compareAt && o.compareAt > o.price && <span className="text-base text-ink-soft">was {money(o.compareAt, o.currency)}</span>}</p>
                      <p className="text-base text-ink-soft">at <span className="font-bold text-navy">{o.retailer}</span> · {o.availability === 'InStock' ? 'listed as in stock' : o.availability === 'OutOfStock' ? 'listed as out of stock' : 'stock not listed'}</p>
                      <p className="mt-3 rounded-xl bg-teal-soft px-4 py-3 text-base"><span className="font-bold">Why: </span>{cap(k.reasons.slice(0, 3).join('; '))}.</p>
                      {k.role === 'best' && res.explanation && <p className="mt-2 text-base text-ink-soft"><span className="font-bold text-navy">In short: </span>{res.explanation} <span className="text-sm">(AI summary of the listing data)</span></p>}
                      {p.features.length > 0 && <ul className="mt-3 text-base text-ink-soft list-disc pl-5 flex-1">{p.features.slice(0, 4).map((f) => <li key={f}>{f}</li>)}</ul>}
                      {p.rating && <p className="mt-2 flex items-start gap-1.5 text-sm text-ink-soft"><Star className="size-4 shrink-0 mt-0.5 fill-amber text-amber" aria-hidden />Listed rating {p.rating.value.toFixed(1)} out of 5 from {p.rating.count} ratings (as provided by Channel3; no reviews checked)</p>}
                      <div className="mt-4 flex flex-col gap-2">
                        <a href={o.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center justify-center gap-2 min-h-12 rounded-full bg-navy text-white px-4 font-bold hover:bg-teal-deep"
                          aria-label={`View ${p.title} at ${o.retailer}, ${money(o.price, o.currency)}. Opens the shop’s website in a new tab`}>
                          View at {o.retailer}<ExternalLink className="size-5" aria-hidden />
                        </a>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <button type="button" aria-pressed={compare.includes(p.id)} onClick={() => toggleCompare(p.id)} className={`inline-flex items-center gap-2 min-h-11 rounded-full border-2 px-4 font-bold ${compare.includes(p.id) ? 'border-teal bg-teal-soft text-teal-deep' : 'border-line hover:border-teal'}`}>
                            <Columns3 className="size-5" aria-hidden />Compare<span className="sr-only"> {p.title}</span>
                          </button>
                          <ReadAloud text={`${ROLE[k.role]}. ${describeItem(p, shortTitle(p.title))} Why: ${k.reasons.slice(0, 2).join(', and ')}.`} label="Read aloud" />
                        </div>
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>

          {pickItems.length > 1 && compare.length < 2 && (
            <Button className="mt-5" variant="secondary" icon={<Columns3 className="size-6" aria-hidden />} onClick={() => { setCompare(pickItems.map((p) => p.id)); setTimeout(() => compareRef.current?.focus(), 50); }}>Compare these side by side</Button>
          )}

          {compareItems.length >= 2 && (
            <div ref={compareRef} tabIndex={-1} className="mt-8 outline-none">
              <Card className="p-5 overflow-x-auto">
                <table className="w-full text-base border-collapse min-w-[36rem]">
                  <caption className="text-left font-display text-2xl font-semibold mb-1">Side by side</caption>
                  <thead><tr><th scope="col" className="text-left p-2 w-40"><span className="sr-only">Detail</span></th>{compareItems.map((p) => <th key={p.id} scope="col" className="text-left p-2 align-bottom">{shortTitle(p.title)}</th>)}</tr></thead>
                  <tbody>
                    {compareRows(compareItems).map((r) => (
                      <tr key={r.label} className="border-t border-line align-top">
                        <th scope="row" className="text-left p-2 text-ink-soft font-bold">{r.label}</th>
                        {r.values.map((v, i) => <td key={i} className="p-2">{v ?? <span className="text-ink-soft italic">Not listed</span>}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 text-sm text-ink-soft">Only what each listing states. “Not listed” means the shop didn’t give it, not that the product lacks it.</p>
                <div className="mt-2 flex flex-wrap gap-4">
                  <ReadAloud text={specsAnswer(compareItems, compareItems.map((p) => shortTitle(p.title)))} label="Read the comparison" />
                  <button type="button" className="font-bold text-teal underline underline-offset-4 min-h-11" onClick={() => setCompare([])}>Close comparison</button>
                </div>
              </Card>
            </div>
          )}

          {others.length > 0 && (
            <details className="mt-8 rounded-2xl border border-line bg-paper p-5">
              <summary className="font-bold cursor-pointer min-h-11 flex items-center">Other listings found ({others.length})</summary>
              <ul className="mt-3 divide-y divide-line">
                {others.map((p) => (
                  <li key={p.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                    <span className="min-w-0"><span className="block font-bold break-words">{p.title}</span><span className="text-base text-ink-soft">{money(p.offers[0].price, p.offers[0].currency)} at {p.offers[0].retailer}</span></span>
                    <span className="flex items-center gap-3">
                      <button type="button" aria-pressed={compare.includes(p.id)} onClick={() => toggleCompare(p.id)} className="min-h-11 rounded-full border-2 border-line px-4 font-bold hover:border-teal">Compare<span className="sr-only"> {p.title}</span></button>
                      <a href={p.offers[0].url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 font-bold text-teal underline underline-offset-4 min-h-11" aria-label={`View ${p.title} at ${p.offers[0].retailer}. Opens the shop’s website in a new tab`}>View<ExternalLink className="size-4" aria-hidden /></a>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="mt-4"><ReadAloud text={readAllSegments(res.products)} label={`Read all ${res.products.length} listings aloud`} /></div>
        </section>
      )}

      <Card className="mt-10 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div><h2 className="text-xl">Want to try a protected payment?</h2><p className="text-ink-soft text-lg">The SaySafe Demo Shop uses real PayPal sandbox payments with family checks.</p></div>
        <LinkButton to="/shop" variant="secondary">Open the Demo Shop</LinkButton>
      </Card>
    </Layout>
  );
}
