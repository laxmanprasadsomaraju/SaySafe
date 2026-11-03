/**
 * Rule `contact_mismatch`: the message claims to be from someone the user saved as a trusted contact
 * (by name, or by relation like "your son" / "Hi Mum"), but the phone number or email in it is not the
 * one the user saved, or it says "new number". Advice: call the number you saved.
 *
 * Runs only on the server, only with the signed-in elder's own contacts. Contacts are NEVER sent to the AI:
 * guardian.ts strips these signals from the brief the model sees.
 */
import type { Signal } from './rules.js';
import { truncateSafe } from './evidence.js';

export interface SavedContact { name: string; relation: string | null; phone: string | null; email: string | null }

export interface ContactCheck {
  contactName: string;
  kind: 'mismatch' | 'same_number' | 'nothing_to_compare';
  advice: string;
  /** Last 4 digits of the number the user saved (shown to the user only). */
  savedNumberEnding: string | null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

/** Compare phone numbers by their last 9 digits (handles +353 / 00353 / 08x forms of the same Irish number). */
export function phoneKey(p: string): string {
  let d = p.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  return d.slice(-9);
}

const CHILD = ['son', 'daughter', 'child', 'kid', 'boy', 'girl'];
const GRANDCHILD = ['grandson', 'granddaughter', 'grandchild', 'grandkid'];
const PARENT_WORDS = /\b(hi|hey|hello|dear)?\s*(mum|mam|mom|mammy|mummy|ma|dad|da|daddy)\b/;
const GRANDPARENT_WORDS = /\b(granny|gran|nana|nan|grandma|grandmother|grandad|granddad|grandpa|grandfather)\b/;

/** Does the text claim to come from this contact? Returns the matching phrase, or null. */
export function claimsToBe(textRaw: string, c: SavedContact): string | null {
  const text = norm(textRaw);
  const rel = c.relation ? norm(c.relation).trim() : '';
  if (rel) {
    const r = esc(rel);
    const m = text.match(new RegExp(`\\b(?:it'?s|its|this is|from)\\s+(?:me,?\\s+)?(?:your|ur)\\s+${r}\\b`)) ?? text.match(new RegExp(`\\b(?:your|ur)\\s+${r}\\b`));
    if (m) return m[0];
    // "Hi Mum, it's me" claims to be one of the user's children; "Hi Granny" one of the grandchildren.
    const claimMe = /\b(it'?s me|its me|this is me|new (phone|number|mobile)|my (new )?(phone|number|mobile))\b/.test(text);
    if (claimMe && CHILD.includes(rel)) { const p = text.match(PARENT_WORDS); if (p && p[2]) return p[0].trim(); }
    if (claimMe && GRANDCHILD.includes(rel)) { const p = text.match(GRANDPARENT_WORDS); if (p) return p[0]; }
  }
  // Name in a claim context: "it's John", "this is John", "from John", "John here", or a sign-off.
  const parts = norm(c.name).split(/\s+/).filter((t) => t.length >= 3);
  const candidates = [norm(c.name).trim(), ...parts].filter(Boolean);
  for (const n of candidates) {
    const e = esc(n);
    const re = new RegExp(`\\b(?:it'?s|its|this is|from|love|thanks|cheers|regards)[,]?\\s+${e}\\b|\\b${e}\\s+here\\b|(?:^|\\n)\\s*[-–—]?\\s*${e}\\s*[.!x]*\\s*$`, 'm');
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

export function checkContacts(text: string, found: { phones: string[]; emails: string[] }, contacts: SavedContact[]): { signals: Signal[]; check: ContactCheck | null } {
  if (!contacts.length) return { signals: [], check: null };
  const lower = norm(text);
  const saysNewNumber = /\b(new|different|changed( my)?|lost my|broke my|broken)\s+(phone|number|mobile|sim)\b|\bmy number (has )?changed\b/.test(lower);
  for (const c of contacts.slice(0, 50)) {
    const claim = claimsToBe(text, c);
    if (!claim) continue;
    const savedPhone = c.phone ? phoneKey(c.phone) : null;
    const savedEmail = c.email ? c.email.toLowerCase().trim() : null;
    const ending = c.phone ? c.phone.replace(/\D/g, '').slice(-4) || null : null;
    const callAdvice = c.phone
      ? `Call ${c.name} on the number you saved${ending ? ` (ending ${ending})` : ''} before you do anything. Don't reply to this message or use the number in it.`
      : `Contact ${c.name} the way you usually do, not through this message. You haven't saved a number for ${c.name} in SaySafe.`;
    const otherPhones = savedPhone ? found.phones.filter((p) => phoneKey(p) !== savedPhone) : [];
    const samePhones = savedPhone ? found.phones.filter((p) => phoneKey(p) === savedPhone) : [];
    const otherEmails = savedEmail ? found.emails.filter((e) => e !== savedEmail) : [];
    const signals: Signal[] = [];
    if (otherPhones.length || (saysNewNumber && !samePhones.length)) {
      signals.push({
        code: 'contact_mismatch', severity: 'medium', family: 'identity', basis: 'deterministic_rule',
        title: `This says it's from ${c.name}, but the number isn't the one you saved`,
        detail: callAdvice,
        evidence: truncateSafe(otherPhones.length ? `${claim} · ${otherPhones.join(', ')}` : claim, 120),
      });
    } else if (otherEmails.length) {
      signals.push({
        code: 'contact_mismatch', severity: 'medium', family: 'identity', basis: 'deterministic_rule',
        title: `This says it's from ${c.name}, but the email address isn't the one you saved`,
        detail: callAdvice,
        evidence: truncateSafe(`${claim} · ${otherEmails.join(', ')}`, 120),
      });
    }
    if (signals.length) return { signals, check: { contactName: c.name, kind: 'mismatch', advice: callAdvice, savedNumberEnding: ending } };
    if (samePhones.length) {
      const advice = `The number matches the one you saved for ${c.name}, but numbers can be faked. If it asks for money or codes, call ${c.name} yourself first.`;
      return {
        signals: [{ code: 'contact_same_number_spoofable', severity: 'info', family: 'contact', basis: 'deterministic_rule', title: `The number matches ${c.name}'s saved number, but numbers can be spoofed`, detail: advice, evidence: truncateSafe(samePhones.join(', '), 60) }],
        check: { contactName: c.name, kind: 'same_number', advice, savedNumberEnding: ending },
      };
    }
    return { signals: [], check: { contactName: c.name, kind: 'nothing_to_compare', advice: callAdvice, savedNumberEnding: ending } };
  }
  return { signals: [], check: null };
}
