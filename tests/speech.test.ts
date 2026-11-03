import { describe, it, expect, beforeEach } from 'vitest';
import { SpeechController, splitSentences, AUTO_MAX_CHARS, type SpeechEnv } from '../web/src/lib/speech';

/** A fake speechSynthesis that records calls and lets the test finish utterances. */
function fakeEnv(opts: { store?: Record<string, string> } = {}) {
  const log: string[] = [];
  const active: any[] = [];
  class U { text: string; rate = 1; lang = ''; voice: any = null; onend: any = null; onerror: any = null; constructor(t: string) { this.text = t; } }
  const synth = {
    speaking: false,
    speak(u: any) { log.push(`speak:${u.text}`); active.push(u); },
    cancel() { log.push('cancel'); const a = active.splice(0); a.forEach((u) => u.onerror?.({ error: 'interrupted' })); },
    getVoices: () => [],
  };
  const store = opts.store ?? {};
  const env: SpeechEnv = { synth: synth as any, Utterance: U as any, storage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } } };
  /** Finish the currently playing utterance (as the browser would). */
  const finish = () => { const u = active.shift(); u?.onend?.({}); };
  return { env, log, active, finish, store };
}

describe('speech controller', () => {
  let f: ReturnType<typeof fakeEnv>;
  let s: SpeechController;
  beforeEach(() => { f = fakeEnv(); s = new SpeechController(f.env); });

  it('speaks one sentence at a time, in order', () => {
    s.speak('First thing. Second thing.');
    expect(f.log.filter((l) => l.startsWith('speak'))).toEqual(['speak:First thing.']);
    f.finish();
    expect(f.log.filter((l) => l.startsWith('speak'))).toEqual(['speak:First thing.', 'speak:Second thing.']);
    f.finish();
    expect(s.getSnapshot().status).toBe('ready');
  });

  it('stop() cancels, clears the queue and nothing more is spoken', () => {
    s.speak('One. Two. Three.');
    s.stop();
    expect(f.log).toContain('cancel');
    f.finish(); // a late onend from the browser must not advance a cleared queue
    expect(f.log.filter((l) => l.startsWith('speak'))).toEqual(['speak:One.']);
    expect(s.getSnapshot().status).toBe('ready');
  });

  it('a new speak cancels the old one: never two at once', () => {
    s.speak('Old reply. Still old.');
    s.speak('New reply.');
    const speaks = f.log.filter((l) => l.startsWith('speak'));
    expect(speaks).toEqual(['speak:Old reply.', 'speak:New reply.']);
    expect(f.log.indexOf('cancel')).toBeLessThan(f.log.indexOf('speak:New reply.'));
    expect(f.active).toHaveLength(1);
    f.finish();
    expect(f.log.filter((l) => l.startsWith('speak'))).toHaveLength(2); // "Still old." never plays
  });

  it('generation counter blocks a stale async reply (fetch still in flight when Stop was pressed)', async () => {
    let resolve!: (t: string) => void;
    const p = s.speak(new Promise<string>((r) => { resolve = r; }));
    s.stop();
    resolve('Late reply.');
    expect(await p).toBe(false);
    expect(f.log.some((l) => l.startsWith('speak'))).toBe(false);
  });

  it('a turn token goes stale on stop / navigation / mic', async () => {
    const turn = s.beginTurn();
    expect(s.getSnapshot().status).toBe('thinking');
    s.setListening(true); // barge-in by tapping the mic
    expect(await s.speak('Reply for the old turn.', { turn })).toBe(false);
    const t2 = s.beginTurn();
    expect(await s.speak('Fresh reply.', { turn: t2 })).toBe(true);
  });

  it('pause then resume restarts from the current sentence (no reliance on synth.resume)', () => {
    s.speak('A one. B two. C three.');
    f.finish(); // now on "B two."
    s.pause();
    expect(s.getSnapshot().status).toBe('paused');
    expect(s.getSnapshot().caption).toBe('B two.');
    f.finish(); // stale callback after cancel: ignored
    s.resume();
    const speaks = f.log.filter((l) => l.startsWith('speak'));
    expect(speaks).toEqual(['speak:A one.', 'speak:B two.', 'speak:B two.']);
  });

  it('mute stops speech and blocks automatic speech; Read aloud (user) unmutes', async () => {
    s.speak('Talking now.');
    s.mute();
    expect(f.log.at(-1)).toBe('cancel');
    expect(await s.speak('Auto reply.')).toBe(false);
    expect(s.getSnapshot().status).toBe('muted');
    expect(await s.speak('Read this.', { priority: 'user' })).toBe(true);
    expect(s.getSnapshot().prefs.muted).toBe(false);
  });

  it('no automatic reading of long text; long text needs an explicit request', async () => {
    const long = 'This is a sentence about a product. '.repeat(20);
    expect(long.length).toBeGreaterThan(AUTO_MAX_CHARS);
    expect(await s.speak(long)).toBe(false);
    expect(await s.speak(long, { priority: 'user' })).toBe(true);
  });

  it('autoSpeak off: replies are not spoken, but Replay still works', async () => {
    s.setPrefs({ autoSpeak: false });
    expect(await s.speak('Short reply.')).toBe(false);
    s.replay();
    expect(f.log.filter((l) => l.startsWith('speak'))).toEqual(['speak:Short reply.']);
  });

  it('preferences persist in localStorage, and the legacy voice-off flag means muted', () => {
    s.setPrefs({ rate: 1.1, readAll: true });
    const again = new SpeechController(f.env);
    expect(again.getSnapshot().prefs).toMatchObject({ rate: 1.1, readAll: true });
    const legacy = new SpeechController(fakeEnv({ store: { 'ss-voice': 'off' } }).env);
    expect(legacy.getSnapshot().prefs.muted).toBe(true);
  });

  it('read-everything list is read part by part and stops instantly', async () => {
    s.setPrefs({ readAll: true });
    await s.speak(['Summary.', 'Listing 1 of 3: Kettle. €30 at shop.ie.', 'Listing 2 of 3: Toaster.', 'Listing 3 of 3: Radio.'], { priority: 'list' });
    f.finish();
    expect(s.getSnapshot().segment).toEqual({ index: 2, total: 4 });
    s.stop();
    f.finish(); f.finish();
    const speaks = f.log.filter((l) => l.startsWith('speak'));
    expect(speaks).toEqual(['speak:Summary.', 'speak:Listing 1 of 3: Kettle.']);
    expect(s.getSnapshot().segment).toBeNull();
  });

  it('read-everything respects mute', async () => {
    s.mute();
    expect(await s.speak(['a.', 'b.'], { priority: 'list' })).toBe(false);
  });

  it('unsupported browsers report unavailable instead of throwing', async () => {
    const u = new SpeechController({ synth: null, Utterance: null, storage: null });
    expect(u.getSnapshot().status).toBe('unavailable');
    expect(await u.speak('hello')).toBe(false);
  });

  it('splitSentences keeps each utterance short', () => {
    const parts = splitSentences(`Short one. ${'word, '.repeat(80)}end.`);
    expect(parts[0]).toBe('Short one.');
    expect(parts.every((p) => p.length <= 230)).toBe(true);
  });
});
