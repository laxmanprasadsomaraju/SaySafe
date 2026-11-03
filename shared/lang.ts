/**
 * "Reply language (beta)": what SaySafe says and hears. The UI stays English, currency stays EUR,
 * and product search stays English. Irish, Hindi and Arabic are deliberately not offered
 * (Whisper rejects `ga`; hi/ar need real-voice testing, ar needs RTL captions).
 */
export const LANGS = {
  en: { label: 'English', name: 'English', bcp47: 'en-IE', whisper: 'en' },
  es: { label: 'Español', name: 'Spanish', bcp47: 'es-ES', whisper: 'es' },
  pl: { label: 'Polski', name: 'Polish', bcp47: 'pl-PL', whisper: 'pl' },
  fr: { label: 'Français', name: 'French', bcp47: 'fr-FR', whisper: 'fr' },
  de: { label: 'Deutsch', name: 'German', bcp47: 'de-DE', whisper: 'de' },
  pt: { label: 'Português', name: 'Portuguese', bcp47: 'pt-PT', whisper: 'pt' },
} as const;
export type LangCode = keyof typeof LANGS;
export const LANG_CODES = Object.keys(LANGS) as LangCode[];

/** Whitelist: anything that isn't one of the offered codes is English. */
export function normaliseLang(v: unknown): LangCode {
  const s = typeof v === 'string' ? v.trim().toLowerCase().slice(0, 5).split(/[-_]/)[0] : '';
  return (LANG_CODES as string[]).includes(s) ? (s as LangCode) : 'en';
}
/** Strict check for the speech-to-text language parameter: only whitelisted codes, never free text. */
export const whisperLanguage = (v: unknown): string => LANGS[normaliseLang(v)].whisper;

const STOPWORDS: Record<LangCode, string[]> = {
  en: ['the', 'and', 'you', 'this', 'that', 'is', 'to', 'it', 'your', 'not', 'please', 'with', 'of'],
  es: ['el', 'la', 'los', 'las', 'que', 'de', 'y', 'no', 'por', 'para', 'este', 'esta', 'su', 'es', 'un', 'una', 'con', 'mensaje'],
  pl: ['nie', 'jest', 'to', 'i', 'w', 'na', 'się', 'z', 'do', 'że', 'ta', 'ten', 'tej', 'pani', 'proszę', 'wiadomość'],
  fr: ['le', 'la', 'les', 'de', 'et', 'ne', 'pas', 'vous', 'ce', 'cette', 'est', 'un', 'une', 'votre', 'message', 'des'],
  de: ['der', 'die', 'das', 'und', 'nicht', 'sie', 'ist', 'ein', 'eine', 'diese', 'dieser', 'ihr', 'zu', 'mit', 'nachricht', 'bitte'],
  pt: ['o', 'a', 'os', 'as', 'que', 'de', 'e', 'não', 'para', 'este', 'esta', 'um', 'uma', 'com', 'sua', 'mensagem', 'por'],
};

/** Rough check that a text is written in `lang` (and not English), from common words. */
export function looksLike(text: string, lang: LangCode): boolean {
  const words = text.toLowerCase().normalize('NFC').split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length < 3) return false;
  const count = (l: LangCode) => words.filter((w) => STOPWORDS[l].includes(w)).length;
  const own = count(lang);
  if (lang === 'en') return own >= 1;
  return own >= 2 && own > count('en');
}

export const replyLanguageInstruction = (lang: LangCode) =>
  lang === 'en' ? '' : `\nLANGUAGE: Write every user-facing sentence ("reply", "reasons", "spoken_summary") in ${LANGS[lang].name}. Keep links, phone numbers, email addresses, brand names and amounts (EUR) exactly as written. Keep any product search "query" in English.`;
