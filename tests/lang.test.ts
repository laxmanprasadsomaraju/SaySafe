import { describe, it, expect, vi, afterEach } from 'vitest';
import { normaliseLang, whisperLanguage, looksLike, LANG_CODES, replyLanguageInstruction } from '../shared/lang';
import { SpeechController, type SpeechEnv } from '../web/src/lib/speech';

describe('reply language whitelist', () => {
  it('offers exactly en, es, pl, fr, de, pt', () => expect(LANG_CODES).toEqual(['en', 'es', 'pl', 'fr', 'de', 'pt']));
  it.each([['es', 'es'], ['ES', 'es'], ['pl-PL', 'pl'], ['fr_FR', 'fr'], ['de', 'de'], ['pt', 'pt'], ['ga', 'en'], ['hi', 'en'], ['ar', 'en'], ['zh', 'en'], ['', 'en'], [null, 'en'], ['en; DROP TABLE', 'en'], [42, 'en']])(
    '%s -> %s', (input, out) => expect(normaliseLang(input)).toBe(out));
  it('Whisper never receives a code outside the list (Irish is rejected by the API)', () => {
    expect(whisperLanguage('ga')).toBe('en');
    expect(whisperLanguage('pl')).toBe('pl');
    expect(whisperLanguage('"; rm -rf')).toBe('en');
  });
  it('language instruction keeps the product query in English', () => {
    expect(replyLanguageInstruction('en')).toBe('');
    expect(replyLanguageInstruction('es')).toMatch(/Spanish[\s\S]*query" in English/);
  });
  it('detects wrong-language replies', () => {
    expect(looksLike('Este mensaje puede ser una estafa. No use los enlaces.', 'es')).toBe(true);
    expect(looksLike('This message may be a scam. Do not use the links.', 'es')).toBe(false);
    expect(looksLike('Ta wiadomość może być oszustwem. Proszę nie klikać w linki.', 'pl')).toBe(true);
  });
});

describe('transcribe forwards the whitelisted language', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sends language=pl, and en for anything not offered', async () => {
    process.env.GROQ_API_KEY = 'test';
    vi.resetModules();
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: any, init: any) => { sent.push(String((init.body as FormData).get('language'))); return new Response(JSON.stringify({ text: 'ok' }), { status: 200 }); }));
    const { transcribe } = await import('../server/ai/provider');
    await transcribe(Buffer.from('x'), 'audio/webm', 'a.webm', 'pl');
    await transcribe(Buffer.from('x'), 'audio/webm', 'a.webm', 'ga');
    expect(sent).toEqual(['pl', 'en']);
    process.env.GROQ_API_KEY = '';
  });
});

describe('fallback to text in another reply language', () => {
  const env = (voices: { lang: string }[]) => {
    const spoken: { text: string; lang: string }[] = [];
    class U { text: string; lang = ''; rate = 1; voice: any; onend: any; onerror: any; constructor(t: string) { this.text = t; } }
    const e: SpeechEnv = { synth: { speak: (u: any) => spoken.push({ text: u.text, lang: u.lang }), cancel: () => {}, getVoices: () => voices as any }, Utterance: U as any, storage: null };
    return { e, spoken };
  };
  it('never speaks English fallback text automatically when Spanish is selected; shows it instead', async () => {
    const { e, spoken } = env([{ lang: 'es-ES' }, { lang: 'en-GB' }]);
    const s = new SpeechController(e); s.unmute(); // spoken replies turned on (off by default)
    s.setPrefs({ lang: 'es' });
    expect(await s.speak('This message may be a scam.', { priority: 'critical', lang: 'en' })).toBe(false);
    expect(spoken).toHaveLength(0);
    expect(s.getSnapshot().notice).toMatch(/shown as text/);
  });
  it('speaks Spanish text with an es-ES utterance when the device has a Spanish voice', async () => {
    const { e, spoken } = env([{ lang: 'es-ES' }]);
    const s = new SpeechController(e); s.unmute(); // spoken replies turned on (off by default)
    s.setPrefs({ lang: 'es' });
    expect(await s.speak('Este mensaje puede ser una estafa.', { lang: 'es' })).toBe(true);
    expect(spoken[0]).toEqual({ text: 'Este mensaje puede ser una estafa.', lang: 'es-ES' });
  });
  it('without a voice for that language it stays silent and says so on screen', async () => {
    const { e, spoken } = env([{ lang: 'en-GB' }]);
    const s = new SpeechController(e); s.unmute(); // spoken replies turned on (off by default)
    s.setPrefs({ lang: 'pl' });
    expect(await s.speak('Ta wiadomość może być oszustwem.', { priority: 'critical', lang: 'pl' })).toBe(false);
    expect(spoken).toHaveLength(0);
    expect(s.getSnapshot().notice).toMatch(/No Polish voice on this device; reading on screen/);
  });
  it('English stays the default and speaks as before', async () => {
    const { e, spoken } = env([]);
    const s = new SpeechController(e); s.unmute(); // spoken replies turned on (off by default)
    expect(await s.speak('Short reply.')).toBe(true);
    expect(spoken[0].lang).toBe('en-IE');
  });
});
