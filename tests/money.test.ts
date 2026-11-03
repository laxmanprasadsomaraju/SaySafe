import { describe, it, expect } from 'vitest';
import { spokenAmount, spokenCents, speakableMoney } from '../shared/money';
import { SpeechController, type SpeechEnv } from '../web/src/lib/speech';

describe('spoken money', () => {
  it('says whole euro amounts without cents', () => {
    expect(spokenAmount(49)).toBe('49 euro');
    expect(spokenAmount(49.0)).toBe('49 euro');
    expect(spokenCents(4900)).toBe('49 euro');
    expect(spokenAmount(1)).toBe('1 euro');
  });
  it('says euro and cent exactly, never rounded', () => {
    expect(spokenAmount(49.99)).toBe('49 euro 99 cent');
    expect(spokenCents(4999)).toBe('49 euro 99 cent');
    expect(spokenAmount(0.5)).toBe('50 cent');
    expect(spokenAmount(10.05)).toBe('10 euro 5 cent');
    expect(spokenCents(129999)).toBe('1299 euro 99 cent');
  });
  it('rewrites amounts inside sentences', () => {
    expect(speakableMoney('That is €49.00 from the shop.')).toBe('That is 49 euro from the shop.');
    expect(speakableMoney('Total €49.99, limit €75.')).toBe('Total 49 euro 99 cent, limit 75 euro.');
    expect(speakableMoney('€1,299.50 at currys.ie')).toBe('1299 euro 50 cent at currys.ie');
    expect(speakableMoney('Paid 49.99 EUR to the demo shop')).toBe('Paid 49 euro 99 cent to the demo shop');
    expect(speakableMoney('€49.5')).toBe('49 euro 50 cent');
    expect(speakableMoney('No money here, version 2.5')).toBe('No money here, version 2.5');
  });
  it('the speech controller speaks the words but the caption keeps the symbol', () => {
    const spoken: string[] = [];
    class U { text: string; rate = 1; lang = ''; voice: any = null; onend: any = null; onerror: any = null; constructor(t: string) { this.text = t; } }
    const env: SpeechEnv = { synth: { speak: (u: any) => spoken.push(u.text), cancel: () => {}, getVoices: () => [] } as any, Utterance: U as any, storage: null };
    const s = new SpeechController(env); s.unmute(); // spoken replies turned on (off by default)
    s.speak('That is €49.99.');
    expect(spoken).toEqual(['That is 49 euro 99 cent.']);
    expect(s.getSnapshot().caption).toBe('That is €49.99.');
  });
});
