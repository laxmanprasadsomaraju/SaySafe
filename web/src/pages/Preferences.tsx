import { useEffect, useState } from 'react';
import { Lock, Trash2 } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button, Card, PageTitle, Notice } from '../components/ui';
import { useMe } from '../lib/session';
import { loadProfile, saveProfile, clearProfile } from '../lib/prefs';
import { EMPTY_PROFILE, type ShoppingProfile } from '../../../shared/shopping';

type ListKey = 'colours' | 'brands' | 'styles' | 'avoid' | 'categories';
const FIELDS: { key: ListKey; label: string; hint: string }[] = [
  { key: 'colours', label: 'Favourite colours', hint: 'For example: white, blue' },
  { key: 'brands', label: 'Favourite brands', hint: 'For example: Panasonic, Russell Hobbs' },
  { key: 'styles', label: 'Styles you like', hint: 'For example: compact, retro, stainless steel' },
  { key: 'avoid', label: 'Things to avoid', hint: 'For example: glass, touch controls, a brand you dislike' },
  { key: 'categories', label: 'Things you shop for often', hint: 'For example: kitchen appliances, radios' },
];

/** Private shopping preferences: edit and clear. Used on its own page and inside Profile. */
export function ShoppingPrefsForm({ headingLevel = 'none' }: { headingLevel?: 'none' | 'h2' }) {
  const [form, setForm] = useState<Record<ListKey, string>>({ colours: '', brands: '', styles: '', avoid: '', categories: '' });
  const [budget, setBudget] = useState('');
  const [status, setStatus] = useState<{ tone: 'ok' | 'danger' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const fill = (p: ShoppingProfile) => {
    setForm({ colours: p.colours.join(', '), brands: p.brands.join(', '), styles: p.styles.join(', '), avoid: p.avoid.join(', '), categories: p.categories.join(', ') });
    setBudget(p.budgetMax !== null ? String(p.budgetMax) : '');
  };
  // A failed load is shown as an error with Retry, never as an empty profile (saving would then wipe the real one).
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const load = () => { setLoadErr(null); loadProfile().then((r) => fill(r.profile)).catch((e: any) => setLoadErr(e?.message || 'Your preferences could not be loaded.')); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setStatus(null);
    try {
      const r = await saveProfile({ ...form, budgetMax: budget.trim() ? Number(budget) : null } as unknown as ShoppingProfile);
      fill(r.profile);
      setStatus({ tone: 'ok', text: r.where === 'account' ? 'Saved. Only you can see these.' : 'Saved in this browser only.' });
    } catch (err: any) { setStatus({ tone: 'danger', text: err.message }); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true); setStatus(null);
    try { await clearProfile(); fill(EMPTY_PROFILE); setStatus({ tone: 'info', text: 'Your preferences are cleared.' }); }
    catch (err: any) { setStatus({ tone: 'danger', text: err.message }); }
    finally { setBusy(false); }
  };

  return (
      <Card className="p-6 md:p-8 max-w-2xl">
        {headingLevel === 'h2' && <h2 id="shopping-h" className="text-2xl mb-3">Shopping preferences</h2>}
        <p className="flex items-start gap-3 text-lg"><Lock className="size-6 text-teal shrink-0 mt-0.5" aria-hidden /><span>Private to you. Your family member can’t see these, and they aren’t shared with shops.</span></p>
        {loadErr && (
          <div className="mt-4" data-testid="prefs-load-error">
            <Notice tone="danger" title="Couldn’t load your saved preferences">
              <p>{loadErr} Nothing was changed. Saving is paused until they load.</p>
              <Button type="button" variant="secondary" className="mt-2" onClick={load}>Retry</Button>
            </Notice>
          </div>
        )}
        <form onSubmit={save} className="mt-6 space-y-5" noValidate>
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={`pf-${f.key}`} className="block font-bold">{f.label}</label>
              <p id={`pf-${f.key}-hint`} className="text-ink-soft text-base">{f.hint}. Separate with commas.</p>
              <input id={`pf-${f.key}`} aria-describedby={`pf-${f.key}-hint`} value={form[f.key]} maxLength={400}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                className="mt-2 w-full min-h-14 rounded-2xl border-2 border-line bg-paper px-5 focus:border-teal outline-none" />
            </div>
          ))}
          <div>
            <label htmlFor="pf-budget" className="block font-bold">Usual budget (€)</label>
            <p id="pf-budget-hint" className="text-ink-soft text-base">Used when you don’t say a price. Leave empty for no limit.</p>
            <input id="pf-budget" aria-describedby="pf-budget-hint" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9.,]/g, '').replace(',', '.'))}
              className="mt-2 w-40 min-h-14 rounded-2xl border-2 border-line bg-paper px-5 focus:border-teal outline-none" />
          </div>
          <div className="flex flex-wrap gap-3 pt-2">
            <Button type="submit" busy={busy} disabled={Boolean(loadErr)}>Save my preferences</Button>
            <Button type="button" variant="danger" icon={<Trash2 className="size-6" aria-hidden />} onClick={clear} disabled={busy}>Clear my preferences</Button>
          </div>
          {status && <Notice tone={status.tone} title={status.text} />}
        </form>
      </Card>
  );
}

export default function Preferences() {
  const me = useMe('elder');
  if (!me) return <Layout><p>Loading…</p></Layout>;
  return (
    <Layout>
      <PageTitle eyebrow="Shopping" title="My preferences" lead="These help me pick from shop listings. I only say a listing matches a preference when the listing itself shows it." />
      <ShoppingPrefsForm />
    </Layout>
  );
}
