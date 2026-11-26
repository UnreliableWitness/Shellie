import { describe, expect, it } from 'vitest';
import { railTag } from './railTag';

const item = (id: string | number) =>
  ({ workItem: { id }, name: 'x' }) as unknown as Parameters<typeof railTag>[0];
const blank = (name: string) => ({ workItem: null, name });

describe('railTag', () => {
  it('is the work item id', () => {
    expect(railTag(item('14'))).toBe('14');
    expect(railTag(item(12345))).toBe('12345');
  });
  it('keeps the end of a long id', () => {
    expect(railTag(item('1234567'))).toBe('…4567');
  });
  it('is the initials of the first two words of a blank task', () => {
    expect(railTag(blank('Scratch notes'))).toBe('SN');
    expect(railTag(blank('queue metrics endpoint'))).toBe('QM');
    expect(railTag(blank('  fix: the build'))).toBe('FT');
  });
  it('is the first two letters of a one-word name', () => {
    expect(railTag(blank('spike'))).toBe('SP');
    expect(railTag(blank('x'))).toBe('X');
    expect(railTag(blank('été'))).toBe('ÉT');
  });
  it('still shows something for a name without letters or digits', () => {
    expect(railTag(blank('---'))).toBe('•');
    expect(railTag(blank(''))).toBe('•');
  });
});
