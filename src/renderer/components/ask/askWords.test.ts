import { describe, expect, it } from 'vitest';
import { tookWords } from './askWords';

describe('tookWords', () => {
  it('says seconds under a minute, at least one', () => {
    expect(tookWords(18_400)).toBe('18 s');
    expect(tookWords(400)).toBe('1 s');
  });
  it('says minutes and seconds, without seconds when there are none', () => {
    expect(tookWords(72_000)).toBe('1 min 12 s');
    expect(tookWords(120_000)).toBe('2 min');
  });
  it('drops the seconds from ten minutes on', () => {
    expect(tookWords(640_000)).toBe('11 min');
  });
});
