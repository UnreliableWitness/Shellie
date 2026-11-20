import { describe, expect, it } from 'vitest';
import { lineDiff } from './lineDiff';

const signs = (before: string, after: string) =>
  lineDiff(before, after).map((h) => h.lines.map((l) => `${l.sign}${l.text}`));

describe('lineDiff', () => {
  it('shows a change with the lines around it', () => {
    expect(signs('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      [' a', '-b', '+B', ' c', '+d'],
    ]);
  });

  it('shows a new file as added lines and a deleted one as removed', () => {
    expect(signs('', 'x\ny\n')).toEqual([['+x', '+y']]);
    expect(signs('x\n', '')).toEqual([['-x']]);
  });

  it('is empty when nothing changed', () => {
    expect(lineDiff('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('keeps three lines of context and splits far apart changes into hunks', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l1\n', 'L1\n').replace('l18', 'L18');
    const hunks = lineDiff(before, after);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].lines.map((l) => l.text)).toEqual([
      'l0',
      'l1',
      'L1',
      'l2',
      'l3',
      'l4',
    ]);
    expect(hunks[1].lines.at(-1)).toEqual({ sign: ' ', text: 'l19', no: 20 });
  });

  it('numbers lines by the after side, and removed lines by the before side', () => {
    expect(lineDiff('a\nb\n', 'a\nc\n')[0].lines).toEqual([
      { sign: ' ', text: 'a', no: 1 },
      { sign: '-', text: 'b', no: 2 },
      { sign: '+', text: 'c', no: 2 },
    ]);
  });

  it('stays bounded on two large, wholly different texts', () => {
    const big = (p: string) =>
      Array.from({ length: 5000 }, (_, i) => `${p}${i}`).join('\n');
    const lines = lineDiff(big('a'), big('b')).flatMap((h) => h.lines);
    expect(lines.filter((l) => l.sign === '-')).toHaveLength(5000);
    expect(lines.filter((l) => l.sign === '+')).toHaveLength(5000);
  });
});
