import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampNavWidth,
  readNavWidth,
  readPrChoice,
  readPrefs,
  readSprintChoice,
  writeNavWidth,
  writePrChoice,
  writePref,
  writeSprintChoice,
} from './uiPrefs';

beforeEach(() => localStorage.clear());

describe('uiPrefs', () => {
  it('defaults to expanded nav and no focus', () => {
    expect(readPrefs()).toEqual({ navCollapsed: false, focus: false });
  });
  it('round-trips', () => {
    writePref('focus', true);
    writePref('navCollapsed', true);
    expect(localStorage.getItem('shellie.ui.focus')).toBe('true');
    expect(readPrefs()).toEqual({ navCollapsed: true, focus: true });
  });
  it('treats bad values as defaults', () => {
    localStorage.setItem('shellie.ui.focus', '{"x":1}');
    localStorage.setItem('shellie.ui.navCollapsed', 'yes');
    expect(readPrefs()).toEqual({ navCollapsed: false, focus: false });
  });
  it('survives a storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readPrefs(broken)).toEqual({ navCollapsed: false, focus: false });
    expect(() => writePref('focus', true, broken)).not.toThrow();
  });
});

describe('pull request choice', () => {
  it('defaults to false and is kept per repo', () => {
    expect(readPrChoice('r1')).toBe(false);
    writePrChoice('r1', true);
    expect(readPrChoice('r1')).toBe(true);
    expect(readPrChoice('r2')).toBe(false);
    writePrChoice('r1', false);
    expect(readPrChoice('r1')).toBe(false);
  });
  it('survives a storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readPrChoice('r1', broken)).toBe(false);
    expect(() => writePrChoice('r1', true, broken)).not.toThrow();
  });
});

describe('nav width (#160)', () => {
  it('defaults to 240 when absent or unreadable', () => {
    expect(readNavWidth()).toBe(240);
    localStorage.setItem('shellie.ui.navWidth', 'wide');
    expect(readNavWidth()).toBe(240);
  });
  it('clamps to 160-480', () => {
    localStorage.setItem('shellie.ui.navWidth', '50');
    expect(readNavWidth()).toBe(160);
    localStorage.setItem('shellie.ui.navWidth', '900');
    expect(readNavWidth()).toBe(480);
    expect(clampNavWidth(300.6)).toBe(301);
  });
  it('round-trips', () => {
    writeNavWidth(320);
    expect(localStorage.getItem('shellie.ui.navWidth')).toBe('320');
    expect(readNavWidth()).toBe(320);
  });
  it('survives a storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readNavWidth(broken)).toBe(240);
    expect(() => writeNavWidth(300, broken)).not.toThrow();
  });
});

describe('sprint choice (#165)', () => {
  it('is null until written and is kept per connection', () => {
    expect(readSprintChoice('c1')).toBeNull();
    writeSprintChoice('c1', { id: 'it-2', team: 'Team B' });
    writeSprintChoice('c2', { id: 'it-3' });
    expect(localStorage.getItem('shellie.ui.sprint.c1')).toBe(
      '{"id":"it-2","team":"Team B"}',
    );
    expect(readSprintChoice('c1')).toEqual({ id: 'it-2', team: 'Team B' });
    expect(readSprintChoice('c2')).toEqual({ id: 'it-3' });
    writeSprintChoice('c1', null);
    expect(localStorage.getItem('shellie.ui.sprint.c1')).toBeNull();
    expect(readSprintChoice('c1')).toBeNull();
  });
  it('treats bad values as no choice', () => {
    for (const bad of [
      '{',
      '"it-2"',
      'null',
      '{"id":5}',
      '{"id":"a","team":1}',
    ]) {
      localStorage.setItem('shellie.ui.sprint.c1', bad);
      expect(readSprintChoice('c1')).toBeNull();
    }
  });
  it('survives a storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readSprintChoice('c1', broken)).toBeNull();
    expect(() => writeSprintChoice('c1', { id: 'x' }, broken)).not.toThrow();
    expect(() => writeSprintChoice('c1', null, broken)).not.toThrow();
  });
});
