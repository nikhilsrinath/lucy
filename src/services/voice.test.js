import { describe, it, expect } from 'vitest';
import { speakable, sentencesOf, pickVoice, voiceGender, tidyTranscript } from './voice';

describe('speakable', () => {
  it('reads the words, not the Markdown', () => {
    expect(speakable('## Runway\n- **8 months** left\n- see [the report](/x)')).toBe('Runway\n8 months left\nsee the report');
  });

  it('turns a table into spoken cells without the rule line', () => {
    const t = speakable('| Client | Due |\n|---|---|\n| Acme | ₹ 500 |');
    expect(t).not.toMatch(/---/);
    expect(t).toMatch(/Acme/);
    expect(t).toMatch(/₹500/);
  });
});

describe('sentencesOf', () => {
  it('splits sentences and keeps offsets that point back into the text', () => {
    const text = 'Got it! Your sync is set. Want a reminder?';
    const s = sentencesOf(text);
    expect(s.map((x) => x.text)).toEqual(['Got it!', 'Your sync is set.', 'Want a reminder?']);
    for (const x of s) expect(text.slice(x.start, x.end)).toBe(x.text);
  });

  it('does not split decimals or abbreviations', () => {
    expect(sentencesOf('Revenue is ₹4.5 lakh. Rs. 500 is due, e.g. from Acme.').map((x) => x.text))
      .toEqual(['Revenue is ₹4.5 lakh.', 'Rs. 500 is due, e.g. from Acme.']);
  });

  it('holds back the unfinished tail while streaming', () => {
    expect(sentencesOf('First one. Second is still com', false).map((x) => x.text)).toEqual(['First one.']);
    // a stop at the very end might be the "4." of "4.5"
    expect(sentencesOf('It is 4.', false)).toEqual([]);
    expect(sentencesOf('It is 4.', true).map((x) => x.text)).toEqual(['It is 4.']);
  });

  it('treats line breaks as ends', () => {
    expect(sentencesOf('Runway\n8 months left').map((x) => x.text)).toEqual(['Runway', '8 months left']);
  });
});

describe('pickVoice', () => {
  it('prefers a natural Indian English voice, then any natural English one', () => {
    const voices = [
      { name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true },
      { name: 'Google US English', lang: 'en-US', localService: false },
      { name: 'Microsoft Neerja Online (Natural) - English (India)', lang: 'en-IN', localService: false },
      { name: 'Hindi', lang: 'hi-IN' },
    ];
    expect(pickVoice(voices).name).toMatch(/Neerja/);
    expect(pickVoice(voices.slice(0, 2)).name).toBe('Google US English');
    expect(pickVoice([])).toBeNull();
  });

  it('gives each cofounder a voice of their own', async () => {
    const { PERSONAS } = await import('../design/personas');
    const edge = ['Neerja', 'Prabhat', 'Sonia', 'Christopher', 'Jenny', 'Ryan', 'Guy', 'Natasha']
      .map((n) => ({ name: `Microsoft ${n} Online (Natural) - English`, lang: 'en-IN', localService: false }));
    const chrome = [
      { name: 'Google US English', lang: 'en-US' }, { name: 'Google UK English Female', lang: 'en-GB' },
      { name: 'Google UK English Male', lang: 'en-GB' }, { name: 'Microsoft Heera - English (India)', lang: 'en-IN' },
      { name: 'Microsoft Ravi - English (India)', lang: 'en-IN' }, { name: 'Microsoft David - English (United States)', lang: 'en-US' },
      { name: 'Microsoft Mark - English (United States)', lang: 'en-US' }, { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
    ];
    for (const voices of [edge, chrome]) {
      const picked = PERSONAS.map((p) => pickVoice(voices, p.voice));
      expect(new Set(picked.map((v) => v.name)).size).toBe(PERSONAS.length);
      PERSONAS.forEach((p, i) => expect(voiceGender(picked[i])).toBe(p.voice.gender));
    }
  });
});

describe('tidyTranscript', () => {
  it('fixes the app words the recogniser mishears', () => {
    expect(tidyTranscript('convert the pro forma for acme and add g s t'))
      .toBe('Convert the proforma for acme and add GST');
    expect(tidyTranscript('what does edge os say about in voices')).toBe('What does EdgeOS say about invoices');
    expect(tidyTranscript('  ')).toBe('');
  });
});

describe('fillers', () => {
  it('suits the filler to what was asked', async () => {
    const { fillerKind } = await import('./voice');
    expect(fillerKind('How much revenue did we make')).toBe('numbers');
    expect(fillerKind('Schedule the team sync for tomorrow')).toBe('request');
    expect(fillerKind('Which clients should I chase first?')).toBe('question');
    expect(fillerKind('the new office')).toBe('generic');
  });

  it('never says the same filler twice in a row', async () => {
    const { pickFiller } = await import('./voice');
    const first = pickFiller('generic', null, () => 0);
    const second = pickFiller('generic', null, () => 0);
    expect(second).not.toBe(first);
  });
});
