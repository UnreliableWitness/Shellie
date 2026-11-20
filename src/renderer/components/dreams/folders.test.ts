import { describe, expect, it } from 'vitest';
import { parseEuros, parseTokens, spacedNumber } from './folders';

describe('parseTokens', () => {
  it('reads digit groups separated by spaces or dots', () => {
    expect(parseTokens('5 000 000')).toBe(5_000_000);
    expect(parseTokens('5.000.000')).toBe(5_000_000);
    expect(parseTokens('5000000')).toBe(5_000_000);
    expect(spacedNumber(5_000_000)).toBe('5 000 000');
  });
  it('refuses a group that is not three digits', () => {
    expect(parseTokens('1.5')).toBeNull();
    expect(parseTokens('1 50')).toBeNull();
    expect(parseTokens('0')).toBeNull();
    expect(parseTokens('abc')).toBeNull();
  });
});

describe('parseEuros', () => {
  it('accepts a plain decimal above zero', () => {
    expect(parseEuros('5')).toBe(5);
    expect(parseEuros('2,50')).toBe(2.5);
    expect(parseEuros('2.5')).toBe(2.5);
  });
  it('refuses everything else', () => {
    for (const bad of ['1e3', '-2', '0', '0.00', '1.234', ' ', 'x', '1 000'])
      expect(parseEuros(bad)).toBeNull();
  });
});
