/**
 * SaySafe design system: the shared class recipes, built only from the tokens in index.css (@theme).
 * Use these instead of re-typing one-off class strings in each page/card, so spacing, radius, targets and
 * focus behave the same everywhere.
 *
 * Spacing scale (Tailwind 4 = 0.25rem steps): 2 (8px) inside a row · 3 (12px) between related lines ·
 * 5 (20px) card padding / gap between cards · 6 (24px) card padding ≥ md · 8/10 (32/40px) between page groups.
 * Radius: --radius-card (cards, 20px) · rounded-2xl (16px, inner panels and inputs) · --radius-pill (buttons, pills).
 * Targets: every control is at least 48px tall (min-h-12); primary actions 56px (min-h-14).
 */
import type { Tone } from '../lib/activity';
import { TONE_CLS } from '../lib/activity';

/** A surface: paper card with the standard border, radius and shadow. Pair with `cardPad`. */
export const card = 'bg-paper rounded-[var(--radius-card)] border border-line shadow-[var(--shadow-card)]';
/** Standard card padding: 20px, 24px from 768px. */
export const cardPad = 'p-5 md:p-6';
/** A quieter surface for secondary groups (no shadow): used for "Demo & help" and inner panels. */
export const panel = 'rounded-[var(--radius-card)] border border-line bg-ivory';
/** Inner panel inside a card (not a card-in-card: no border/shadow of its own). */
export const inset = 'rounded-2xl bg-ivory p-4';

const btnBase = 'inline-flex items-center justify-center gap-2 rounded-full font-bold disabled:opacity-60 disabled:cursor-not-allowed';
export const btnPrimary = `${btnBase} min-h-14 px-5 bg-teal text-white hover:bg-teal-deep`;
/** Compact primary (48px) for actions inside a card row. */
export const btnPrimarySm = `${btnBase} min-h-12 px-4 bg-teal text-white hover:bg-teal-deep`;
export const btnSecondary = `${btnBase} min-h-12 px-4 border-2 border-line bg-paper text-navy hover:border-teal`;
export const btnDanger = `${btnBase} min-h-12 px-4 border-2 border-danger bg-paper text-danger hover:bg-danger-soft`;
export const btnDangerSolid = `${btnBase} min-h-12 px-4 bg-danger text-white hover:bg-[color-mix(in_srgb,var(--color-danger)_85%,black)]`;
export const btnOutlineTeal = `${btnBase} min-h-12 px-4 border-2 border-teal text-teal-deep bg-paper hover:bg-teal-soft`;
/** Underlined text link that is still a 48px target. */
export const linkBtn = 'font-bold text-teal underline underline-offset-4 min-h-12 inline-flex items-center gap-1';
/** A full-width navigation row inside a card list (label left, chevron right). */
export const linkRow = 'flex items-center justify-between gap-3 py-3 min-h-14 font-bold hover:text-teal';
export const input = 'w-full min-w-0 min-h-12 rounded-2xl border-2 border-line bg-paper px-4 focus:border-teal outline-none';
/** On/Off switch button (role="switch"). Navy when on, outlined when off; never colour alone: the word says it. */
export const switchBtn = (on: boolean) => `shrink-0 inline-flex items-center justify-center gap-2 min-h-12 min-w-20 px-4 rounded-full border-2 font-bold ${on ? 'bg-navy text-white border-navy' : 'bg-paper text-navy border-line hover:border-teal'}`;
/** Status pill. rounded-xl (not a full pill) so a long label that wraps at 320px still reads as one label. */
export const pill = (tone: Tone) => `inline-flex items-center gap-1 rounded-xl border px-2.5 py-0.5 text-sm font-bold ${TONE_CLS[tone]}`;
/** Small uppercase label above a group of cards. */
export const eyebrow = 'font-sans text-teal font-bold uppercase tracking-[0.14em] text-sm';
