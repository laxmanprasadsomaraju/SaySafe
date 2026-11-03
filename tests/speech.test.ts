import { describe, it, expect, beforeEach } from 'vitest';
import { SpeechController, splitSentences, AUTO_MAX_CHARS, voiceEffect, type SpeechEnv } from '../web/src/lib/speech';

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
  // These tests are about playback behaviour once the person has turned spoken replies on (consent is tested below).
  beforeEach(() => { f = fakeEnv(); s = new SpeechController(f.env); s.unmute(); });

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
    s.stopAll(); // Stop control / navigation / mic barge-in all invalidate the turn
    expect(await s.speak('Reply for the old turn.', { turn })).toBe(false);
    const t2 = s.beginTurn();
    expect(await s.speak('Fresh reply.', { turn: t2 })).toBe(true);
  });

  it('speaking (or pausing) a reply never makes its own turn stale; Stop does (live bug: Channel3 listings dropped)', async () => {
    const turn = s.beginTurn();
    expect(await s.speak('That is not in the Demo Shop.', { turn })).toBe(true); // plays
    expect(s.isCurrent(turn)).toBe(true); // the rest of the turn (real listings) still shows
    s.pause(); expect(s.isCurrent(turn)).toBe(true);
    s.mute(); expect(s.isCurrent(turn)).toBe(true); // turning spoken replies off silences, keeps the turn
    s.stop(); expect(s.isCurrent(turn)).toBe(false);
    expect(await s.speak('Late.', { turn })).toBe(false);
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

  it('mute stops speech and blocks automatic speech; Read aloud (user) plays once and stays muted', async () => {
    s.speak('Talking now.');
    s.mute();
    expect(f.log.at(-1)).toBe('cancel');
    expect(await s.speak('Auto reply.')).toBe(false);
    expect(await s.speak('Watch out: scam.', { priority: 'critical' })).toBe(false);
    expect(s.getSnapshot().status).toBe('muted');
    expect(await s.speak('Read this.', { priority: 'user' })).toBe(true);
    // The saved setting and the switch keep saying Muted: pressing Read aloud never flips it behind the user's back.
    expect(s.getSnapshot().prefs.muted).toBe(true);
    expect(JSON.parse(f.store['ss-voice-prefs']).muted).toBe(true);
    f.finish();
    expect(s.getSnapshot().status).toBe('muted');
    expect(await s.speak('Next auto reply.')).toBe(false);
  });

  it('muted keeps the automatic choices saved; unmuting brings them back without re-ticking anything', async () => {
    s.setPrefs({ autoSpeak: true, readAll: true });
    s.mute();
    expect(voiceEffect(s.getSnapshot().prefs)).toMatchObject({ playback: 'muted', autoShort: 'saved-muted', readAll: 'saved-muted' });
    expect(voiceEffect(s.getSnapshot().prefs).note).toMatch(/^Spoken replies are off\. .*saved, but nothing plays until you turn on spoken replies/);
    expect(voiceEffect(s.getSnapshot().prefs).note).not.toMatch(/mute/i);
    expect(await s.speak('Short reply.')).toBe(false);
    const reloaded = new SpeechController(f.env); // persisted exactly as shown
    expect(reloaded.getSnapshot().prefs).toMatchObject({ muted: true, autoSpeak: true, readAll: true });
    s.unmute();
    expect(voiceEffect(s.getSnapshot().prefs)).toMatchObject({ playback: 'on', autoShort: 'on', readAll: 'on', note: null });
    expect(await s.speak('Short reply.')).toBe(true);
  });

  it('voiceEffect: automatic options that are off read as off, whatever playback is; unsupported says so', () => {
    expect(voiceEffect({ muted: false, autoSpeak: false, readAll: false })).toMatchObject({ playback: 'on', autoShort: 'off', readAll: 'off' });
    expect(voiceEffect({ muted: true, autoSpeak: false, readAll: false })).toMatchObject({ autoShort: 'off', readAll: 'off' });
    expect(voiceEffect({ muted: false, autoSpeak: true, readAll: false }, false)).toMatchObject({ playback: 'unavailable' });
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

  it('consent: spoken replies are OFF for a fresh visitor and only ON after the person turns them on (persisted)', async () => {
    // Fresh visitor: no storage → spoken replies off, nothing plays automatically (not even a safety warning).
    const fresh = fakeEnv({ store: {} });
    const c = new SpeechController(fresh.env);
    expect(c.getSnapshot().prefs.muted).toBe(true);
    expect(await c.speak('Hello Mary.')).toBe(false);
    expect(await c.speak('Watch out: scam.', { priority: 'critical' })).toBe(false);
    expect(fresh.log.some((l) => l.startsWith('speak'))).toBe(false);
    // A button the person presses (Read aloud / Replay) still plays, without turning spoken replies on.
    expect(await c.speak('Read this.', { priority: 'user' })).toBe(true);
    expect(c.getSnapshot().prefs.muted).toBe(true);
    // Old saved prefs that were "on" only by default (no opt-in), stale test profiles and the legacy key → off.
    for (const store of <Record<string, string>[]>[{ 'ss-voice-prefs': JSON.stringify({ muted: false, autoSpeak: true }) }, { 'ss-voice': 'on' }, { 'ss-voice-prefs': JSON.stringify({ muted: true, mutedByUser: true }) }, { 'ss-voice-prefs': '{not json' }]) {
      expect(new SpeechController(fakeEnv({ store }).env).getSnapshot().prefs.muted).toBe(true);
    }
    // The person turns them on → remembered across reloads; turning off is remembered too.
    c.unmute();
    expect(JSON.parse(fresh.store['ss-voice-prefs'])).toMatchObject({ muted: false, spokenOptIn: true });
    expect(new SpeechController(fresh.env).getSnapshot().prefs.muted).toBe(false);
    expect(await new SpeechController(fresh.env).speak('Short reply.')).toBe(true);
    c.mute();
    expect(JSON.parse(fresh.store['ss-voice-prefs'])).toMatchObject({ muted: true, spokenOptIn: false });
    expect(new SpeechController(fresh.env).getSnapshot().prefs.muted).toBe(true);
  });
  it('preferences persist with the opt-in', () => {
    s.setPrefs({ rate: 1.1, readAll: true });
    expect(new SpeechController(f.env).getSnapshot().prefs).toMatchObject({ rate: 1.1, readAll: true, muted: false });
  });
  it('autoplay block before the first tap shows "needs tap" (Tap to enable sound) once turned on; never while off', () => {
    let active = false;
    const e = fakeEnv({ store: {} }).env;
    const c = new SpeechController({ ...e, activated: () => active });
    expect(c.getSnapshot()).toMatchObject({ needsTap: false, prefs: { muted: true } }); // off: nothing to unlock
    c.unmute();
    expect(c.getSnapshot()).toMatchObject({ needsTap: true, status: 'ready', prefs: { muted: false } });
    active = true; c.activate();
    expect(c.getSnapshot().needsTap).toBe(false);
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

  it('splitSentences keeps prices and domains whole', () => {
    expect(splitSentences('Best match is the X, €99.99 at currys.ie. It is listed as in stock! Ok?')).toEqual(['Best match is the X, €99.99 at currys.ie.', 'It is listed as in stock!', 'Ok?']);
  });
  it('splitSentences keeps each utterance short', () => {
    const parts = splitSentences(`Short one. ${'word, '.repeat(80)}end.`);
    expect(parts[0]).toBe('Short one.');
    expect(parts.every((p) => p.length <= 230)).toBe(true);
  });
});
