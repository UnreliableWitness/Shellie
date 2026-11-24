import { describe, expect, it } from 'vitest';
import { RecentCount } from './recent';

describe('RecentCount', () => {
  it('sums what was added within the window', () => {
    let now = 1_000_000;
    const c = new RecentCount(30_000, () => now);
    c.add();
    now += 10_000;
    c.add(4);
    expect(c.total()).toBe(5);
  });

  it('forgets what is older than the window', () => {
    let now = 1_000_000;
    const c = new RecentCount(30_000, () => now);
    c.add(7);
    now += 29_000;
    c.add(2);
    expect(c.total()).toBe(9);
    now += 2_000;
    expect(c.total()).toBe(2);
    now += 60_000;
    expect(c.total()).toBe(0);
  });

  it('keeps one entry per second, however often it is added to', () => {
    let now = 1_000_000;
    const c = new RecentCount(30_000, () => now);
    for (let i = 0; i < 10_000; i++) {
      c.add();
      now += 1;
    }
    expect(c.total()).toBe(10_000);
    expect(c.size).toBeLessThanOrEqual(11);
  });
});
