import { useState } from 'react';
import { MessageCircle, Share2, Copy, Check } from 'lucide-react';
import { Button, Card } from './ui';
import { buildShareText, whatsappUrl } from '../lib/shareText';
import type { ScanResult } from '../lib/api';

/**
 * Optional "Share warning on WhatsApp". Shows exactly what will be shared first.
 * wa.me without a number: the person picks the contact inside WhatsApp. Nothing is sent by SaySafe.
 */
export function ShareWarning({ result }: { result: ScanResult }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = buildShareText(result);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { setCopied(false); }
  };
  const share = async () => { try { await navigator.share({ text }); } catch { /* cancelled */ } };
  return (
    <Card className="p-6">
      <h3 className="text-2xl">Warn someone else</h3>
      {!open ? (
        <>
          <p className="mt-2 text-lg text-ink-soft">Send a short warning to a friend or family member. You choose who gets it.</p>
          <Button className="mt-4" variant="secondary" icon={<MessageCircle className="size-6" aria-hidden />} onClick={() => setOpen(true)} aria-expanded={false} aria-controls="share-preview">Share warning on WhatsApp</Button>
        </>
      ) : (
        <div id="share-preview">
          <p className="mt-2 text-lg font-bold">This is exactly what will be shared:</p>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-2xl border-2 border-line bg-ivory p-4 font-sans text-base" aria-label="Text that will be shared">{text}</pre>
          <p className="mt-2 text-base text-ink-soft">It does not include the message itself, names, numbers, email addresses, links or payment details from it.</p>
          <div className="mt-4 flex flex-col gap-3">
            <a href={whatsappUrl(text)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center gap-3 rounded-[var(--radius-pill)] font-bold min-h-14 px-7 text-[1.125rem] bg-teal text-white hover:bg-teal-deep">
              <MessageCircle className="size-6" aria-hidden />Open WhatsApp<span className="sr-only"> (opens in a new tab)</span>
            </a>
            {canShare && <Button variant="secondary" icon={<Share2 className="size-6" aria-hidden />} onClick={share}>Share another way</Button>}
            <Button variant="secondary" icon={copied ? <Check className="size-6" aria-hidden /> : <Copy className="size-6" aria-hidden />} onClick={copy}>{copied ? 'Copied' : 'Copy text'}</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
          <p role="status" className="sr-only">{copied ? 'Copied to clipboard' : ''}</p>
        </div>
      )}
    </Card>
  );
}
