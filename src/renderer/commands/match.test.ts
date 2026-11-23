import { describe, expect, it } from 'vitest';
import { rank } from './match';
import type { Command } from './types';

const cmd = (title: string): Command => ({
  id: title,
  title,
  group: 'goto',
  run: () => undefined,
});
const titles = (cs: Command[]) => cs.map((c) => c.title);

describe('rank', () => {
  const all = [
    cmd('Switch to project Rome'),
    cmd('Sprint'),
    cmd('Show changes'),
    cmd('Home'),
  ];

  it('returns the commands as given for an empty query', () => {
    expect(rank('', all)).toBe(all);
    expect(rank('  ', all)).toBe(all);
  });

  it('puts a substring match before a scattered one', () => {
    expect(titles(rank('spr', all))).toEqual([
      'Sprint',
      'Switch to project Rome',
    ]);
  });

  it('matches letters in order, whatever their case', () => {
    expect(titles(rank('SC', all))).toContain('Show changes');
  });

  it('puts an earlier substring before a later one', () => {
    expect(titles(rank('om', all))).toEqual(['Home', 'Switch to project Rome']);
  });

  it('returns nothing when nothing matches', () => {
    expect(rank('zzz', all)).toEqual([]);
  });
});
