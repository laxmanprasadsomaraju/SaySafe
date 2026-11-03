import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, HelpCircle, Mic, Loader2, Square, ShieldCheck, Info } from 'lucide-react';
import type { VoiceState } from '../lib/voice';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const base = 'inline-flex items-center justify-center gap-3 rounded-[var(--radius-pill)] font-bold min-h-14 px-7 text-[1.125rem] transition-[background-color,border-color,transform] duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed';
const variants: Record<Variant, string> = {
  primary: 'bg-teal text-white hover:bg-teal-deep shadow-[var(--shadow-lift)]',
  secondary: 'bg-paper text-navy border-2 border-line hover:border-teal',
  ghost: 'text-teal hover:bg-teal-soft',
  danger: 'bg-paper text-danger border-2 border-danger hover:bg-danger-soft',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: ReactNode; busy?: boolean }>(
  ({ variant = 'primary', icon, busy, children, className = '', ...rest }, ref) => (
    <button ref={ref} className={`${base} ${variants[variant]} ${className}`} aria-busy={busy || undefined} {...rest}>
      {busy ? <Loader2 className="size-6 animate-spin" aria-hidden /> : icon}
      <span>{children}</span>
    </button>
  ),
);

export function LinkButton({ to, variant = 'primary', icon, children, className = '' }: { to: string; variant?: Variant; icon?: ReactNode; children: ReactNode; className?: string }) {
  return <Link to={to} className={`${base} ${variants[variant]} ${className}`}>{icon}<span>{children}</span></Link>;
}

export function Card({ children, className = '', as: As = 'section', ...rest }: { children: ReactNode; className?: string; as?: any; [k: string]: any }) {
  return <As className={`bg-paper rounded-[var(--radius-card)] border border-line shadow-[var(--shadow-card)] ${className}`} {...rest}>{children}</As>;
}

export function PageTitle({ eyebrow, title, lead }: { eyebrow?: string; title: string; lead?: string }) {
  return (
    <header className="mb-8 fade-up">
      {eyebrow && <p className="text-teal font-bold uppercase tracking-[0.14em] text-sm mb-2">{eyebrow}</p>}
      <h1 className="text-[length:var(--text-title)] md:text-[length:var(--text-hero)]">{title}</h1>
      {lead && <p className="mt-3 text-[length:var(--text-lead)] text-ink-soft max-w-2xl">{lead}</p>}
    </header>
  );
}

/** Large, labelled mic button with explicit states (never icon-only). */
export function MicButton({ state, onClick, size = 'lg', label = 'Tap to speak' }: { state: VoiceState; onClick: () => void; size?: 'lg' | 'md'; label?: string }) {
  if (state === 'unsupported') return <p className="max-w-xs text-center text-lg text-ink-soft font-bold">Voice input isn’t available in this browser. Please type instead.</p>;
  const dims = size === 'lg' ? 'size-36 md:size-40' : 'size-20';
  const text = state === 'listening' ? 'Listening… tap to stop' : state === 'processing' ? 'Working it out…' : label;
  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        disabled={state === 'processing'}
        aria-pressed={state === 'listening'}
        aria-label={text}
        className={`${dims} rounded-full grid place-items-center text-white transition-colors ${state === 'listening' ? 'bg-danger mic-listening' : 'bg-teal hover:bg-teal-deep shadow-[var(--shadow-lift)]'}`}
      >
        {state === 'processing' ? <Loader2 className="size-12 animate-spin" aria-hidden /> : state === 'listening' ? <Square className="size-10" aria-hidden fill="currentColor" /> : <Mic className={size === 'lg' ? 'size-14' : 'size-9'} aria-hidden />}
      </button>
      <span className="font-bold text-lg" aria-live="polite">{text}</span>
    </div>
  );
}

/** What the assistant said, always shown as text too (captions). */
export function Caption({ text, lang }: { text: string | null; lang?: string }) {
  if (!text) return null;
  return (
    <div role="status" aria-live="polite" lang={lang && lang !== 'en' ? lang : undefined} className="fade-up flex gap-3 items-start bg-teal-soft text-navy rounded-2xl px-5 py-4 text-[length:var(--text-lead)]">
      <ShieldCheck className="size-7 shrink-0 text-teal mt-0.5" aria-hidden />
      <p>{text}</p>
    </div>
  );
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title: string; children?: ReactNode }) {
  const map = {
    info: ['bg-teal-soft border-teal', Info, 'text-teal'],
    ok: ['bg-teal-soft border-teal', CheckCircle2, 'text-teal'],
    warn: ['bg-amber-soft border-amber', HelpCircle, 'text-amber'],
    danger: ['bg-danger-soft border-danger', AlertTriangle, 'text-danger'],
  } as const;
  const [cls, Icon, ic] = map[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`border-l-[6px] rounded-2xl px-5 py-4 ${cls}`}>
      <p className="font-bold flex items-center gap-2"><Icon className={`size-6 ${ic}`} aria-hidden />{title}</p>
      {children && <div className="mt-1 text-ink-soft">{children}</div>}
    </div>
  );
}

export function SandboxBadge() {
  return <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-soft text-amber font-bold text-sm px-3 py-1 border border-amber/30">PayPal sandbox · demo money</span>;
}

export function TextInput(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string; id: string }) {
  const { label, hint, id, className = '', ...rest } = props;
  return (
    <div>
      <label htmlFor={id} className="block font-bold mb-2">{label}</label>
      {hint && <p id={`${id}-hint`} className="text-ink-soft mb-2 text-lg">{hint}</p>}
      <textarea id={id} aria-describedby={hint ? `${id}-hint` : undefined} className={`w-full rounded-2xl border-2 border-line bg-paper px-5 py-4 text-[length:var(--text-body)] focus:border-teal outline-none ${className}`} {...rest} />
    </div>
  );
}
