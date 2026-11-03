/**
 * A guide screenshot: phone (390) and/or desktop (1440) capture, a caption, alt text, a label when the image comes
 * from the local test build (mock PayPal), and click-to-enlarge in an accessible modal dialog (focus kept inside,
 * Escape and the Close button close it, focus returns to the image button).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Maximize2, X, Monitor, Smartphone } from 'lucide-react';
import { shotFiles, type ShotFile } from './shots';
import type { ShotRef } from './content';

export function Figure({ shot, prefer = 'phone', compact = false }: { shot: ShotRef; prefer?: 'phone' | 'desktop'; compact?: boolean }) {
  const f = shotFiles(shot.id);
  const both = Boolean(f.phone && f.desktop);
  const [view, setView] = useState<'phone' | 'desktop'>(prefer === 'desktop' ? (f.desktop ? 'desktop' : 'phone') : (f.phone ? 'phone' : 'desktop'));
  const cur: ShotFile | undefined = view === 'phone' ? f.phone ?? f.desktop : f.desktop ?? f.phone;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const capId = useId();

  if (!cur) {
    return (
      <figure className="rounded-2xl border-2 border-dashed border-line bg-ivory p-5 text-ink-soft" data-shot-missing={shot.id}>
        <p className="font-bold text-navy">Screenshot pending hosted run</p>
        <figcaption className="mt-1 text-base">{shot.cap}</figcaption>
      </figure>
    );
  }
  const isPhone = cur.viewport < 600;
  return (
    <figure className={`min-w-0 ${isPhone ? (compact ? 'w-[13rem]' : 'w-[16rem]') + ' max-w-full' : (compact ? 'w-full md:w-[24rem]' : 'w-full lg:w-[34rem]')}`} data-shot={shot.id}>
      <button ref={trigger} type="button" onClick={() => setOpen(true)} aria-describedby={capId}
        className={`group relative block w-full text-left ${isPhone ? 'rounded-[1.75rem] bg-navy p-1.5' : 'rounded-2xl border border-line bg-paper p-1'} focus-visible:outline-offset-4`}>
        <img src={cur.file} alt={shot.alt} width={cur.width} height={cur.height} loading="lazy" decoding="async"
          className={`block w-full h-auto ${isPhone ? 'rounded-[1.4rem]' : 'rounded-xl'} bg-paper`} />
        <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-navy/90 px-3 py-1 text-sm font-bold text-white"><Maximize2 className="size-4" aria-hidden />Enlarge<span className="sr-only"> screenshot</span></span>
      </button>
      <figcaption id={capId} className="mt-2 text-base font-bold text-ink-soft">
        {shot.cap}
        {cur.source === 'local' && <span className="block text-sm font-normal text-amber">Illustration from local test build{cur.paypalMock ? ' (mock PayPal; IDs hidden)' : ''}</span>}
      </figcaption>
      {both && (
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={`Screenshot size: ${shot.cap}`}>
          {(['phone', 'desktop'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
              className={`inline-flex items-center gap-1.5 min-h-11 px-3 rounded-full border-2 text-sm font-bold ${view === v ? 'bg-navy text-white border-navy' : 'bg-paper text-navy border-line hover:border-teal'}`}>
              {v === 'phone' ? <Smartphone className="size-4" aria-hidden /> : <Monitor className="size-4" aria-hidden />}{v === 'phone' ? 'Phone' : 'Computer'}
            </button>
          ))}
        </div>
      )}
      {open && <Lightbox src={cur.file} alt={shot.alt} cap={shot.cap} local={cur.source === 'local'} mock={cur.paypalMock} w={cur.width} h={cur.height} onClose={() => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }} />}
    </figure>
  );
}

export function Lightbox({ src, alt, cap, local = false, mock, w, h, onClose }: { src: string; alt: string; cap: string; local?: boolean; mock: boolean; w: number; h: number; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (!d.open) d.showModal?.();
    d.querySelector<HTMLElement>('[data-close]')?.focus();
    return () => { if (d.open) d.close(); };
  }, []);
  // Keep Tab inside the dialog (the page behind is inert while it is open).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const f = [...(ref.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? [])];
    if (!f.length) return;
    const first = f[0]; const lastEl = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
  };
  return (
    <dialog ref={ref} aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); onClose(); }} onKeyDown={onKeyDown}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(72rem,calc(100vw-2rem))] overflow-auto rounded-[var(--radius-card)] bg-paper p-4 sm:p-6 text-navy backdrop:bg-navy/70" data-testid="shot-dialog">
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-xl min-w-0 break-words">{cap}</h2>
        <button type="button" data-close onClick={onClose} className="shrink-0 inline-flex items-center gap-2 min-h-12 px-4 rounded-full border-2 border-line font-bold hover:border-teal"><X className="size-5" aria-hidden />Close</button>
      </div>
      {(local || mock) && <p className="mt-2 text-base font-bold text-amber">{mock ? 'Illustration from local test build (mock PayPal; IDs hidden). Not a real sandbox payment.' : 'Illustration from local test build.'}</p>}
      <img src={src} alt={alt} width={w} height={h} className="mt-4 mx-auto block h-auto max-w-full rounded-xl border border-line" style={{ maxHeight: w < h ? '80dvh' : undefined, width: 'auto' }} />
      <p className="mt-3 text-base text-ink-soft">{alt}</p>
      <a href={src} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-12 items-center font-bold text-teal underline underline-offset-4">Open the image on its own<span className="sr-only"> (opens in a new tab)</span></a>
    </dialog>
  );
}
