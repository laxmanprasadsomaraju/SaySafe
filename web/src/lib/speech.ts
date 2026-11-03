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
import { VAD, MIC_MESSAGES, pickMime, browserMeter, type MicEnv } from './mic';
import { dropTranscript } from '../../../shared/voice';

/** One state for all of SaySafe's voice: mic, transcription, AI turn and speech. */
export type SpeechStatus = 'ready' | 'listening' | 'processing' | 'thinking' | 'speaking' | 'paused' | 'cancelled' | 'muted' | 'unavailable' | 'error';
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
  /** Mic outcome to show on screen, never spoken ("I didn't hear anything. Tap to try again."). */
  micMessage: string | null;
  micSupported: boolean;
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
  private activity: 'listening' | 'processing' | 'thinking' | null = null;
  private micSession = 0;
  private micCleanup: (() => void) | null = null;
  private micMessage: string | null = null;
  private cancelledUntil = 0;
  private lastTranscript = { text: '', at: 0 };
  private lastText: string | string[] | null = null;
  private lastPriority: SpeechPriority = 'user';
  private err: string | null = null;
  private notice: string | null = null;
  private textLang: LangCode = 'en';
  private lastLang: LangCode = 'en';
  private prefs: SpeechPrefs;
  private listeners = new Set<() => void>();
  private snap: SpeechSnapshot;

  constructor(private env: SpeechEnv, private mic: MicEnv | null = null) {
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
      : this.activity === 'processing' ? 'processing'
      : this.err ? 'error'
      : this.speaking ? 'speaking'
      : this.paused ? 'paused'
      : this.activity === 'thinking' ? 'thinking'
      : this.cancelledUntil > Date.now() ? 'cancelled'
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
      micMessage: this.micMessage,
      micSupported: this.micSupported(),
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
  beginTurn(): number { this.stop(); this.micMessage = null; if (!this.micBusy) this.activity = 'thinking'; this.emit(); return this.gen; }
  isCurrent(turn: number) { return turn === this.gen; }
  /** Clear the "thinking" state if a turn ended without speech (error, nothing to say). */
  endThinking() { if (this.activity === 'thinking') { this.activity = null; this.emit(); } }
  // ----- microphone (tap-to-talk). One session at a time; every callback checks its session token. -----
  micSupported() { return Boolean(this.mic?.getUserMedia && this.mic?.MediaRecorder); }
  get micBusy() { return this.activity === 'listening' || this.activity === 'processing'; }

  /** The mic button: idle -> listen; listening/processing -> cancel quietly; speaking -> stop speech, then listen. */
  micToggle(onText: (t: string) => void) {
    if (this.micBusy) { this.cancelListening(); return; }
    void this.startListening(onText);
  }

  /** Cancel listening/transcribing without a sound. Any late recorder or transcription result is ignored. */
  cancelListening() {
    if (!this.micBusy) return;
    this.micSession++;
    this.micCleanup?.(); this.micCleanup = null;
    this.activity = null; this.micMessage = null;
    this.cancelledUntil = Date.now() + 1500;
    this.emit();
    setTimeout(() => this.emit(), 1600); // let the "Cancelled" chip fall back to Ready
  }

  /** The Stop control: stops speech, listening and processing, and makes any pending AI reply stale. */
  stopAll() {
    this.micSession++;
    this.micCleanup?.(); this.micCleanup = null;
    if (this.activity) this.activity = null;
    this.micMessage = null; this.cancelledUntil = 0;
    this.stop();
  }

  async startListening(onText: (t: string) => void): Promise<void> {
    const mic = this.mic;
    if (!mic?.getUserMedia || !mic.MediaRecorder) { this.micMessage = MIC_MESSAGES.unsupported; this.emit(); return; }
    if (this.micBusy) return; // never two recorders
    this.stop(); // barge-in: silence SaySafe first (also makes any in-flight AI reply stale)
    const session = ++this.micSession;
    const lang = this.prefs.lang;
    this.activity = 'listening'; this.micMessage = null; this.cancelledUntil = 0;
    this.emit();

    let stream: MediaStream;
    try {
      stream = await mic.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e: any) {
      if (session !== this.micSession) return;
      this.activity = null;
      this.micMessage = e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? MIC_MESSAGES.denied : MIC_MESSAGES.unavailable;
      this.emit(); return;
    }
    const stopTracks = () => { try { stream.getTracks().forEach((t) => t.stop()); } catch { /* */ } };
    if (session !== this.micSession) { stopTracks(); return; } // cancelled while the permission prompt was open

    const mime = pickMime(mic.MediaRecorder);
    let rec: MediaRecorder;
    try { rec = new mic.MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch { stopTracks(); this.activity = null; this.micMessage = MIC_MESSAGES.unavailable; this.emit(); return; }
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const meter = mic.meter(stream);
    const startAt = mic.now();
    let voicedMs = 0, heard = false, lastVoiceAt = startAt, finishing = false;
    let tick: ReturnType<typeof setInterval> | null = null;
    const release = () => { if (tick) clearInterval(tick); tick = null; meter?.close(); stopTracks(); };
    this.micCleanup = () => { rec.onstop = null; release(); try { if (rec.state !== 'inactive') rec.stop(); } catch { /* */ } };

    const finish = (reason: 'silence' | 'done') => {
      if (finishing || session !== this.micSession) return;
      finishing = true;
      const duration = mic.now() - startAt;
      if (tick) clearInterval(tick); tick = null;
      rec.onstop = async () => {
        release();
        if (session !== this.micSession) return; // cancelled meanwhile: drop silently
        this.micCleanup = null;
        // No voice, too short, or silence timeout: never upload. Whisper turns silence into "Thank you."
        const noMeter = meter === null;
        if (reason === 'silence' || duration < VAD.minClipMs || (!noMeter && !heard)) {
          this.activity = null; this.micMessage = MIC_MESSAGES.nothingHeard; this.emit(); return;
        }
        this.activity = 'processing'; this.emit();
        let text = '';
        try { text = await mic.transcribe(new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }), { voicedMs: noMeter ? 0 : voicedMs, lang, mime: rec.mimeType || mime }); }
        catch { if (session === this.micSession) { this.activity = null; this.micMessage = MIC_MESSAGES.unclear; this.emit(); } return; }
        if (session !== this.micSession) return; // Stop / navigation / new tap while transcribing
        const dropped = dropTranscript(text, noMeter ? 0 : voicedMs);
        this.activity = null;
        if (dropped) { this.micMessage = MIC_MESSAGES.nothingHeard; this.emit(); return; }
        const clean = text.trim().slice(0, 4000);
        const now = mic.now();
        if (clean.toLowerCase() === this.lastTranscript.text.toLowerCase() && now - this.lastTranscript.at < 10_000) { this.micMessage = MIC_MESSAGES.duplicate; this.emit(); return; }
        this.lastTranscript = { text: clean, at: now };
        this.emit();
        onText(clean);
      };
      try { if (rec.state !== 'inactive') rec.stop(); else void rec.onstop?.(new Event('stop')); } catch { void rec.onstop?.(new Event('stop')); }
    };

    try { rec.start(); } catch { release(); this.activity = null; this.micMessage = MIC_MESSAGES.unavailable; this.emit(); return; }
    tick = setInterval(() => {
      if (session !== this.micSession) { if (tick) clearInterval(tick); return; }
      const t = mic.now();
      const lvl = meter ? meter.level() : 0;
      if (lvl >= VAD.floor) { voicedMs += VAD.tickMs; lastVoiceAt = t; if (voicedMs >= VAD.minVoicedMs) heard = true; }
      if (meter && !heard && t - startAt >= VAD.silenceTimeoutMs) finish('silence');
      else if (heard && t - lastVoiceAt >= VAD.endOfSpeechMs) finish('done');
      else if (t - startAt >= (meter ? VAD.maxMs : 8000)) finish(meter && !heard ? 'silence' : 'done');
    }, VAD.tickMs);
  }

  setThinking(on: boolean) { if (on) { if (!this.micBusy) this.activity = 'thinking'; } else if (this.activity === 'thinking') this.activity = null; this.emit(); }

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

function browserMic(): MicEnv | null {
  if (typeof window === 'undefined') return null;
  const md = navigator.mediaDevices;
  return {
    getUserMedia: typeof md?.getUserMedia === 'function' ? (c) => md.getUserMedia(c) : null,
    MediaRecorder: 'MediaRecorder' in window ? (window as any).MediaRecorder : null,
    meter: browserMeter,
    now: () => performance.now(),
    transcribe: async (blob, info) => {
      const fd = new FormData();
      fd.append('audio', blob, info.mime.includes('mp4') ? 'speech.mp4' : info.mime.includes('ogg') ? 'speech.ogg' : 'speech.webm');
      fd.append('language', info.lang);
      fd.append('voicedMs', String(Math.round(info.voicedMs)));
      const res = await fetch('/api/voice/transcribe', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-SaySafe-Lang': info.lang } });
      if (!res.ok) throw new Error('transcribe failed');
      const j = await res.json().catch(() => ({}));
      return typeof j.text === 'string' ? j.text : '';
    },
  };
}

export const speech = new SpeechController(browserEnv(), browserMic());
if (typeof window !== 'undefined') {
  (window as any).__saysafeSpeech = speech; // for QA scripts
  window.addEventListener('pagehide', () => speech.stopAll());
}
