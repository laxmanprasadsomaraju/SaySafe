/**
 * The ONE place SaySafe makes sound. Every page speaks through `speech` (or the useSpeech hook).
 *
 * - One utterance at a time: a new speak() cancels whatever is playing.
 * - stop() calls speechSynthesis.cancel(), clears the queue and bumps a generation counter, so a
 *   stale utterance callback or a reply still being fetched can never start talking later.
 * - Text is split into sentences and spoken one by one, with the index tracked. Pause = cancel and
 *   remember the sentence; Resume = speak again from that sentence. This avoids Chrome's unreliable
 *   speechSynthesis.pause()/resume() and its ~15 s cut-off on long utterances.
 * - Preferences (muted, autoSpeak, rate, readAll) live in localStorage.
 * - Automatic speech is for short replies only. Long text is only read when the user asks
 *   ("Read aloud", "Replay") or has turned on "Read everything".
 */

import { LANGS, normaliseLang, type LangCode } from '../../../shared/lang';

export type SpeechStatus = 'ready' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'muted' | 'unavailable' | 'error';
/** auto: short reply, only if autoSpeak is on. critical: safety warning, spoken if autoSpeak is on even when longer.
 *  user: the user pressed a Read aloud / Replay button (unmutes). list: the opt-in "Read everything" mode. */
export type SpeechPriority = 'auto' | 'critical' | 'user' | 'list';
export interface SpeechPrefs { muted: boolean; autoSpeak: boolean; rate: number; readAll: boolean; lang: LangCode }
export interface SpeechSnapshot {
  status: SpeechStatus;
  supported: boolean;
  prefs: SpeechPrefs;
  /** The sentence being spoken now (or where it paused). */
  caption: string;
  /** Present while a multi-part list is being read: which part, of how many. */
  segment: { index: number; total: number } | null;
  canReplay: boolean;
  error: string | null;
  /** Why something was shown as text instead of spoken (language / no voice). */
  notice: string | null;
}

export interface SpeechEnv {
  synth: Pick<SpeechSynthesis, 'speak' | 'cancel' | 'getVoices'> & Partial<Pick<SpeechSynthesis, 'resume' | 'paused' | 'addEventListener'>> | null;
  Utterance: (new (text: string) => SpeechSynthesisUtterance) | null;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
}

export const AUTO_MAX_CHARS = 320;
export const PREFS_KEY = 'ss-voice-prefs';
const DEFAULT_PREFS: SpeechPrefs = { muted: false, autoSpeak: true, rate: 0.95, readAll: false, lang: 'en' };

/** Split into sentences; very long sentences are split again at commas so each utterance stays short. */
export function splitSentences(text: string): string[] {
  // Split only where punctuation is followed by a space, so "€99.99" and "currys.ie" stay whole.
  const parts = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?]["”’)]?)\s+(?=\S)/);
  const out: string[] = [];
  for (const raw of parts) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length <= 220) { out.push(s); continue; }
    let buf = '';
    for (const piece of s.split(/(?<=,)\s+/)) {
      if ((buf + ' ' + piece).trim().length > 220 && buf) { out.push(buf.trim()); buf = piece; } else buf = `${buf} ${piece}`;
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}

interface Item { text: string; seg: number }

export class SpeechController {
  private gen = 0;
  private queue: Item[] = [];
  private index = 0;
  private segTotal = 0;
  private speaking = false;
  private paused = false;
  private activity: 'listening' | 'thinking' | null = null;
  private lastText: string | string[] | null = null;
  private lastPriority: SpeechPriority = 'user';
  private err: string | null = null;
  private notice: string | null = null;
  private textLang: LangCode = 'en';
  private lastLang: LangCode = 'en';
  private prefs: SpeechPrefs;
  private listeners = new Set<() => void>();
  private snap: SpeechSnapshot;

  constructor(private env: SpeechEnv) {
    this.prefs = this.loadPrefs();
    this.snap = this.build();
    try { env.synth?.addEventListener?.('voiceschanged', () => this.emit()); } catch { /* optional */ }
  }

  /** A device voice for this language (en falls back to the default voice, others never do). */
  private voiceFor(lang: LangCode): SpeechSynthesisVoice | null {
    try {
      const voices = this.env.synth?.getVoices() ?? [];
      if (lang === 'en') return voices.find((x) => /^en-(IE|GB)/i.test(x.lang)) ?? voices.find((x) => /^en/i.test(x.lang)) ?? null;
      return voices.find((x) => x.lang?.toLowerCase().startsWith(lang)) ?? null;
    } catch { return null; }
  }
  hasVoice(lang: LangCode) { return lang === 'en' || this.voiceFor(lang) !== null; }

  // ----- store plumbing (useSyncExternalStore) -----
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.snap;
  private emit() { this.snap = this.build(); this.listeners.forEach((l) => l()); }
  private build(): SpeechSnapshot {
    const supported = Boolean(this.env.synth && this.env.Utterance);
    const status: SpeechStatus = this.activity === 'listening' ? 'listening'
      : this.err ? 'error'
      : this.speaking ? 'speaking'
      : this.paused ? 'paused'
      : this.activity === 'thinking' ? 'thinking'
      : !supported ? 'unavailable'
      : this.prefs.muted ? 'muted' : 'ready';
    const cur = this.queue[Math.min(this.index, this.queue.length - 1)];
    return {
      status, supported, prefs: { ...this.prefs },
      caption: (this.speaking || this.paused) && cur ? cur.text : '',
      segment: (this.speaking || this.paused) && this.segTotal > 1 && cur ? { index: cur.seg + 1, total: this.segTotal } : null,
      canReplay: this.lastText !== null && supported,
      error: this.err,
      notice: this.notice,
    };
  }

  // ----- preferences -----
  private loadPrefs(): SpeechPrefs {
    const st = this.env.storage;
    let p = { ...DEFAULT_PREFS };
    try {
      const raw = st?.getItem(PREFS_KEY);
      if (raw) {
        const j = JSON.parse(raw);
        p = {
          muted: typeof j.muted === 'boolean' ? j.muted : p.muted,
          autoSpeak: typeof j.autoSpeak === 'boolean' ? j.autoSpeak : p.autoSpeak,
          rate: typeof j.rate === 'number' && j.rate >= 0.6 && j.rate <= 1.5 ? j.rate : p.rate,
          readAll: typeof j.readAll === 'boolean' ? j.readAll : p.readAll,
          lang: normaliseLang(j.lang),
        };
      } else if (st?.getItem('ss-voice') === 'off') p.muted = true; // legacy "Voice" toggle
    } catch { /* defaults */ }
    return p;
  }
  private savePrefs() {
    try {
      this.env.storage?.setItem(PREFS_KEY, JSON.stringify(this.prefs));
      this.env.storage?.setItem('ss-voice', this.prefs.muted ? 'off' : 'on');
    } catch { /* private mode */ }
  }
  setPrefs(patch: Partial<SpeechPrefs>) {
    this.prefs = { ...this.prefs, ...patch };
    this.savePrefs();
    if (patch.muted) this.stop(); else this.emit();
  }
  mute() { this.setPrefs({ muted: true }); }
  unmute() { this.setPrefs({ muted: false }); }
  toggleMute() { this.setPrefs({ muted: !this.prefs.muted }); }

  // ----- turns: a token that goes stale when anything newer happens -----
  get generation() { return this.gen; }
  /** Call when the user sends something: stops current speech and returns a token for the reply. */
  beginTurn(): number { this.stop(); this.activity = 'thinking'; this.emit(); return this.gen; }
  isCurrent(turn: number) { return turn === this.gen; }
  /** Clear the "thinking" state if a turn ended without speech (error, nothing to say). */
  endThinking() { if (this.activity === 'thinking') { this.activity = null; this.emit(); } }
  /** Mic state. Starting the mic is a barge-in: it stops speech. */
  setListening(on: boolean) {
    if (on) { this.stop(); this.activity = 'listening'; }
    else if (this.activity === 'listening') this.activity = null;
    this.emit();
  }
  setThinking(on: boolean) { if (on) this.activity = 'thinking'; else if (this.activity === 'thinking') this.activity = null; this.emit(); }

  /**
   * Speak text (or a list of parts, read one after another). Returns true if speech started.
   * A Promise is awaited first; if anything newer happened meanwhile (stop, navigation, another speak) it is dropped.
   */
  async speak(input: string | string[] | Promise<string | string[]>, opts: { priority?: SpeechPriority; turn?: number; lang?: LangCode } = {}): Promise<boolean> {
    if (opts.turn !== undefined && opts.turn !== this.gen) return false;
    if (input instanceof Promise) {
      const g = this.gen;
      let v: string | string[];
      try { v = await input; } catch { return false; }
      if (g !== this.gen) return false;
      return this.speakNow(v, opts.priority ?? 'auto', opts.lang ?? 'en');
    }
    return this.speakNow(input, opts.priority ?? 'auto', opts.lang ?? 'en');
  }

  private speakNow(input: string | string[], priority: SpeechPriority, lang: LangCode = 'en'): boolean {
    const parts = (Array.isArray(input) ? input : [input]).map((t) => t.trim()).filter(Boolean);
    if (this.activity === 'thinking') this.activity = null;
    this.notice = null;
    if (!parts.length) { this.emit(); return false; }
    this.lastText = Array.isArray(input) ? parts : parts[0];
    this.lastPriority = priority;
    this.lastLang = lang;
    // Reply language: never speak text in another language automatically (e.g. an English fallback
    // while Spanish is selected). It stays on screen. A user-pressed "Read aloud" may read it in its own language.
    if (priority !== 'user' && lang !== this.prefs.lang) {
      this.notice = `This reply is in ${LANGS[lang].name}, so it is shown as text only.`;
      this.emit(); return false;
    }
    if (lang !== 'en' && this.env.synth && !this.voiceFor(lang)) {
      this.notice = `No ${LANGS[lang].name} voice on this device; reading on screen.`;
      this.emit(); return false;
    }
    const total = parts.join(' ').length;
    if (!this.env.synth || !this.env.Utterance) { this.emit(); return false; }
    if (this.prefs.muted) {
      if (priority !== 'user') { this.emit(); return false; }
      this.prefs.muted = false; this.savePrefs(); // pressing "Read aloud" is an explicit request to hear it
    }
    if (priority === 'auto' && (!this.prefs.autoSpeak || total > AUTO_MAX_CHARS)) { this.emit(); return false; }
    if (priority === 'critical' && !this.prefs.autoSpeak) { this.emit(); return false; }

    this.hardCancel();
    const g = ++this.gen;
    this.queue = parts.flatMap((p, seg) => splitSentences(p).map((text) => ({ text, seg })));
    this.segTotal = parts.length;
    this.index = 0;
    this.err = null;
    this.paused = false;
    this.textLang = lang;
    this.play(g);
    return true;
  }

  private play(g: number) {
    if (g !== this.gen) return;
    const synth = this.env.synth, U = this.env.Utterance;
    if (!synth || !U) return;
    if (this.index >= this.queue.length) { this.speaking = false; this.queue = []; this.index = 0; this.segTotal = 0; this.emit(); return; }
    const u = new U(this.queue[this.index].text);
    u.rate = this.prefs.rate;
    u.lang = LANGS[this.textLang].bcp47;
    const v = this.voiceFor(this.textLang); if (v) u.voice = v;
    u.onend = () => { if (g !== this.gen) return; this.index++; this.play(g); };
    u.onerror = (e: any) => {
      if (g !== this.gen) return;
      if (e?.error === 'interrupted' || e?.error === 'canceled') return;
      this.speaking = false; this.queue = []; this.err = 'Speech stopped unexpectedly. You can read the text on screen.'; this.emit();
    };
    this.speaking = true;
    try { if (synth.paused) synth.resume?.(); synth.speak(u); } catch { this.speaking = false; this.err = 'Speech is not available right now.'; }
    this.emit();
  }

  private hardCancel() { try { this.env.synth?.cancel(); } catch { /* */ } }

  /** Stop now: cancel, clear the queue, invalidate anything pending. */
  stop() {
    this.gen++;
    this.hardCancel();
    this.queue = []; this.index = 0; this.segTotal = 0;
    this.speaking = false; this.paused = false; this.err = null; this.notice = null;
    this.emit();
  }
  pause() {
    if (!this.speaking) return;
    this.gen++; // the cancelled utterance's callbacks are now stale
    this.hardCancel();
    this.speaking = false; this.paused = true;
    this.emit();
  }
  resume() {
    if (!this.paused) return;
    if (this.prefs.muted) { this.stop(); return; }
    this.paused = false;
    const g = ++this.gen;
    this.play(g); // restart from the current sentence
  }
  togglePause() { if (this.paused) this.resume(); else this.pause(); }
  replay() { if (this.lastText !== null) this.speakNow(this.lastText, this.lastPriority === 'list' ? 'list' : 'user', this.lastLang); }
}

function browserEnv(): SpeechEnv {
  if (typeof window === 'undefined') return { synth: null, Utterance: null, storage: null };
  let storage: SpeechEnv['storage'] = null;
  try { storage = window.localStorage; } catch { /* blocked */ }
  return {
    synth: 'speechSynthesis' in window ? window.speechSynthesis : null,
    Utterance: typeof (window as any).SpeechSynthesisUtterance === 'function' ? (window as any).SpeechSynthesisUtterance : null,
    storage,
  };
}

export const speech = new SpeechController(browserEnv());
if (typeof window !== 'undefined') {
  (window as any).__saysafeSpeech = speech; // for QA scripts
  window.addEventListener('pagehide', () => speech.stop());
}
