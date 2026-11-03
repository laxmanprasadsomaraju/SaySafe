/**
 * Ghost-speech regression tests for the single voice controller (speech.ts + mic.ts).
 * Fake MediaRecorder, fake level meter, fake speechSynthesis, fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpeechController, type SpeechEnv } from '../web/src/lib/speech';
import { VAD, MIC_MESSAGES, type MicEnv } from '../web/src/lib/mic';
import { dropTranscript, isSilenceHallucination } from '../shared/voice';
import { parseFollowup } from '../shared/shopping';

function setup(opts: { level?: (ms: number) => number; deny?: string; noMeter?: boolean; transcript?: string; deferred?: boolean; noMic?: boolean } = {}) {
  const log: string[] = [];
  class U { text: string; onend: any; onerror: any; rate = 1; lang = ''; voice: any; constructor(t: string) { this.text = t; } }
  const active: any[] = [];
  const env: SpeechEnv = {
    synth: { speak: (u: any) => { log.push(`speak:${u.text}`); active.push(u); }, cancel: () => { log.push('cancel'); active.splice(0).forEach((u) => u.onerror?.({ error: 'interrupted' })); }, getVoices: () => [] } as any,
    Utterance: U as any, storage: null,
  };
  const recorders: any[] = [];
  let tracksStopped = 0, metersClosed = 0, startedAt = 0;
  class MR {
    state = 'inactive'; mimeType = 'audio/webm'; ondataavailable: any = null; onstop: any = null;
    static isTypeSupported = () => true;
    constructor(public stream: any) { recorders.push(this); }
    start() { this.state = 'recording'; startedAt = Date.now(); }
    stop() { if (this.state === 'inactive') return; this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'.repeat(5000)]) }); queueMicrotask(() => this.onstop?.(new Event('stop'))); }
  }
  let resolveT: ((t: string) => void) | null = null;
  const transcribe = vi.fn((_b: Blob, _i: any) => (opts.deferred ? new Promise<string>((r) => { resolveT = r; }) : Promise.resolve(opts.transcript ?? 'find me a kettle')));
  const mic: MicEnv | null = opts.noMic ? null : {
    getUserMedia: async () => { if (opts.deny) throw Object.assign(new Error('x'), { name: opts.deny }); return { getTracks: () => [{ stop: () => { tracksStopped++; } }] } as any; },
    MediaRecorder: MR as any,
    meter: () => (opts.noMeter ? null : { level: () => (opts.level ?? (() => 0))(Date.now() - startedAt), close: () => { metersClosed++; } }),
    transcribe,
    now: () => Date.now(),
  };
  const s = new SpeechController(env, mic);
  const onText = vi.fn();
  return { s, log, recorders, transcribe, onText, resolve: (t: string) => resolveT?.(t), counts: () => ({ tracksStopped, metersClosed }) };
}
const recording = (r: any[]) => r.filter((x) => x.state === 'recording').length;
const speaks = (log: string[]) => log.filter((l) => l.startsWith('speak'));
const voiceFor = (ms: number) => (t: number) => (t < ms ? 0.12 : 0.001); // someone talks for `ms`, then quiet

describe('mic: silence never reaches the AI and never makes SaySafe talk', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('mic start then stop (tap again) without speaking: no upload, no AI, no speech, mic released', async () => {
    const t = setup();
    t.s.micToggle(t.onText);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.s.getSnapshot().status).toBe('listening');
    t.s.micToggle(t.onText); // tap while listening = cancel
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(t.onText).not.toHaveBeenCalled();
    expect(speaks(t.log)).toHaveLength(0);
    expect(recording(t.recorders)).toBe(0);
    expect(t.counts().tracksStopped).toBe(1);
  });

  it('silence timeout: stops quietly with a text-only message', async () => {
    const t = setup();
    t.s.micToggle(t.onText);
    await vi.advanceTimersByTimeAsync(VAD.silenceTimeoutMs + 200);
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(t.onText).not.toHaveBeenCalled();
    expect(t.s.getSnapshot().micMessage).toBe("I didn't hear anything. Tap to try again.");
    expect(t.s.getSnapshot().status).toBe('ready');
    expect(speaks(t.log)).toHaveLength(0); // the message is shown, never spoken
  });

  it('room noise / a click shorter than the voice threshold is not uploaded', async () => {
    const t = setup({ level: voiceFor(100) }); // 100 ms blip < minVoicedMs
    t.s.micToggle(t.onText);
    await vi.advanceTimersByTimeAsync(VAD.silenceTimeoutMs + 200);
    expect(t.transcribe).not.toHaveBeenCalled();
  });

  it('real speech is sent once and handed to the page', async () => {
    const t = setup({ level: voiceFor(1200) });
    t.s.micToggle(t.onText);
    await vi.advanceTimersByTimeAsync(1200 + VAD.endOfSpeechMs + 200);
    expect(t.transcribe).toHaveBeenCalledTimes(1);
    expect(t.transcribe.mock.calls[0][1].voicedMs).toBeGreaterThanOrEqual(1000);
    expect(t.onText).toHaveBeenCalledWith('find me a kettle');
  });

  it('Whisper silence hallucination ("Thank you.") after a short blip is dropped', async () => {
    const t = setup({ level: voiceFor(400), transcript: 'Thank you.' });
    t.s.micToggle(t.onText);
    await vi.advanceTimersByTimeAsync(400 + VAD.endOfSpeechMs + 200);
    expect(t.transcribe).toHaveBeenCalledTimes(1);
    expect(t.onText).not.toHaveBeenCalled();
    expect(t.s.getSnapshot().micMessage).toBe(MIC_MESSAGES.nothingHeard);
    expect(speaks(t.log)).toHaveLength(0);
  });

  it('punctuation-only transcripts are dropped', async () => {
    const t = setup({ level: voiceFor(2000), transcript: ' . ' });
    t.s.micToggle(t.onText);
    await vi.advanceTimersByTimeAsync(2000 + VAD.endOfSpeechMs + 200);
    expect(t.onText).not.toHaveBeenCalled();
  });

  it('duplicate transcript within 10 s is not sent again', async () => {
    const t = setup({ level: voiceFor(1000) });
    t.s.micToggle(t.onText);
    await vi.advanceTimersByTimeAsync(3000);
    t.s.micToggle(t.onText);
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.onText).toHaveBeenCalledTimes(1);
    expect(t.s.getSnapshot().micMessage).toBe(MIC_MESSAGES.duplicate);
  });

  it('late transcription result after cancel (Stop) is ignored', async () => {
    const t = setup({ level: voiceFor(1000), deferred: true });
    t.s.micToggle(t.onText);
    await vi.advanceTimersByTimeAsync(1000 + VAD.endOfSpeechMs + 200);
    expect(t.s.getSnapshot().status).toBe('processing');
    t.s.stopAll();
    t.resolve('find me a kettle');
    await vi.advanceTimersByTimeAsync(100);
    expect(t.onText).not.toHaveBeenCalled();
    expect(t.s.getSnapshot().status).toBe('ready');
  });

  it('rapid taps never create two recorders and never upload silence', async () => {
    const t = setup();
    for (let i = 0; i < 7; i++) { t.s.micToggle(t.onText); await vi.advanceTimersByTimeAsync(30); }
    expect(recording(t.recorders)).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(VAD.silenceTimeoutMs + 500);
    expect(recording(t.recorders)).toBe(0);
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(t.onText).not.toHaveBeenCalled();
  });

  it('rapid Stop/Start cycles leave nothing running', async () => {
    const t = setup({ level: voiceFor(5000) });
    for (let i = 0; i < 10; i++) { void t.s.startListening(t.onText); await vi.advanceTimersByTimeAsync(80); t.s.stopAll(); }
    await vi.advanceTimersByTimeAsync(20000);
    expect(recording(t.recorders)).toBe(0);
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(t.counts().tracksStopped).toBe(10);
    expect(t.s.getSnapshot().status).toBe('ready');
  });

  it('tapping the mic while SaySafe speaks stops speech at once (cancel + clear queue), then listens', async () => {
    const t = setup();
    await t.s.speak('One. Two. Three.', { priority: 'user' });
    t.s.micToggle(t.onText);
    expect(t.log).toContain('cancel');
    await vi.advanceTimersByTimeAsync(50);
    expect(t.s.getSnapshot().status).toBe('listening');
    expect(speaks(t.log)).toEqual(['speak:One.']); // "Two." and "Three." never play
  });

  it('starting the mic makes an in-flight AI reply stale', async () => {
    const t = setup();
    const turn = t.s.beginTurn();
    t.s.micToggle(t.onText);
    await vi.advanceTimersByTimeAsync(50);
    expect(await t.s.speak('You are welcome!', { turn })).toBe(false);
    expect(speaks(t.log)).toHaveLength(0);
  });

  it('an old AI response arriving after a newer request is ignored', async () => {
    const t = setup();
    const first = t.s.beginTurn();
    const second = t.s.beginTurn();
    expect(t.s.isCurrent(first)).toBe(false);
    expect(await t.s.speak('Old answer.', { turn: first })).toBe(false);
    expect(await t.s.speak('New answer.', { turn: second })).toBe(true);
    expect(speaks(t.log)).toEqual(['speak:New answer.']);
  });

  it('navigation while listening or speaking (RouteSpeechGuard -> stopAll) releases everything', async () => {
    const t = setup({ level: voiceFor(5000) });
    t.s.micToggle(t.onText);
    await vi.advanceTimersByTimeAsync(500);
    t.s.stopAll();
    await t.s.speak('Hello there. More.', { priority: 'user' });
    t.s.stopAll();
    await vi.advanceTimersByTimeAsync(20000);
    expect(recording(t.recorders)).toBe(0);
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(speaks(t.log)).toEqual(['speak:Hello there.']);
  });

  it('permission denied falls back to typing with a clear message', async () => {
    const t = setup({ deny: 'NotAllowedError' });
    await t.s.startListening(t.onText);
    expect(t.s.getSnapshot().micMessage).toMatch(/Microphone access is turned off/);
    expect(t.s.getSnapshot().status).toBe('ready');
  });

  it('no microphone / MediaRecorder support: unsupported message, nothing thrown', async () => {
    const t = setup({ noMic: true });
    expect(t.s.getSnapshot().micSupported).toBe(false);
    await t.s.startListening(t.onText);
    expect(t.s.getSnapshot().micMessage).toBe(MIC_MESSAGES.unsupported);
  });

  it('without a level meter, hallucination phrases are always dropped', async () => {
    const t = setup({ noMeter: true, transcript: 'Thank you.' });
    t.s.micToggle(t.onText);
    await vi.advanceTimersByTimeAsync(8200);
    expect(t.onText).not.toHaveBeenCalled();
  });

  it('Read everything is off by default', () => {
    expect(setup().s.getSnapshot().prefs.readAll).toBe(false);
  });
});

describe('transcript filters', () => {
  it.each(['Thank you.', 'thank you', "You're welcome.", 'Thanks for watching!', '.', '...', '  ', 'Bye.', 'you'])('"%s" is a silence hallucination', (t) => expect(isSilenceHallucination(t)).toBe(true));
  it('real requests pass', () => {
    expect(dropTranscript('Find me a kettle under 40 euro', 400)).toBeNull();
    expect(dropTranscript('Is this message from PayPal real?', 0)).toBeNull();
  });
  it('a real, sustained "thank you" is allowed; a short one is not', () => {
    expect(dropTranscript('Thank you.', 300)).toBe('silence_hallucination');
    expect(dropTranscript('Thank you.', 2000)).toBeNull();
  });
});

describe('follow-ups interrupting a search', () => {
  it('"No, show me the cheaper ones" is a cheaper re-query', () => {
    expect(parseFollowup('No, show me the cheaper ones', true).kind).toBe('cheaper');
    expect(parseFollowup('no stop', true).kind).toBe('stop');
  });
});
