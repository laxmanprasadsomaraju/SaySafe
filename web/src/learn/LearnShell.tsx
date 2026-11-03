/**
 * Shared frame for /learn, /learn/:slug, /judges and /features: the app's own Layout, in the visitor's mode (public
 * website, or inside the app for Mary/Alex so the tabs stay), plus the small "Learn SaySafe" sub-navigation.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { api } from '../lib/api';

export type Who = 'elder' | 'family' | 'public';
export function useWho(): Who | null {
  const [who, setWho] = useState<Who | null>(null);
  useEffect(() => { api<{ elder?: unknown; family?: unknown }>('/api/me').then((r) => setWho(r.elder ? 'elder' : r.family ? 'family' : 'public')).catch(() => setWho('public')); }, []);
  return who;
}

const SUB = [
  { to: '/learn', label: 'Learn SaySafe' },
  { to: '/judges', label: 'Judges’ Guide' },
  { to: '/features', label: 'Features' },
];

export function LearnShell({ children }: { children: ReactNode }) {
  const who = useWho();
  const { pathname } = useLocation();
  const inApp = who === 'elder' || who === 'family';
  return (
    <Layout mode={inApp ? (who as 'elder' | 'family') : 'public'}>
      <div className={inApp ? '' : 'wrap py-8 md:py-12'}>
        <nav aria-label="Learn SaySafe" className="mb-8">
          <ul className="flex flex-wrap gap-2">
            {SUB.map((s) => {
              const cur = s.to === '/learn' ? pathname === '/learn' || pathname.startsWith('/learn/') : pathname === s.to;
              return <li key={s.to}><Link to={s.to} aria-current={cur ? 'page' : undefined} className={`inline-flex items-center min-h-12 px-4 rounded-full border-2 font-bold ${cur ? 'bg-navy text-white border-navy' : 'bg-paper text-navy border-line hover:border-teal'}`}>{s.label}</Link></li>;
            })}
          </ul>
        </nav>
        {children}
      </div>
    </Layout>
  );
}

/** A typed prompt the reader can copy: shown exactly as it should be typed. */
export function Prompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="mt-2 flex flex-wrap items-center gap-2">
      <code className="rounded-xl bg-teal-soft text-navy px-3 py-2 font-sans font-bold text-base break-words min-w-0" data-prompt>{text}</code>
      <button type="button" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
        className="inline-flex items-center min-h-11 px-3 rounded-full border-2 border-line text-sm font-bold hover:border-teal">{copied ? 'Copied' : 'Copy'}<span className="sr-only"> this prompt</span></button>
    </span>
  );
}
