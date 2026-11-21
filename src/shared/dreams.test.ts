import { describe, expect, it } from 'vitest';
import {
  canSwitchOn,
  confirmSentence,
  defaultDreaming,
  DreamingSettingsSchema,
  widens,
  widenings,
  type DreamingSettings,
} from './dreams';
import { AppSettingsSchema } from './usage';

const ready = (over: Partial<DreamingSettings> = {}): DreamingSettings => ({
  ...defaultDreaming(),
  model: 'zai/glm-5.3',
  testedModel: 'zai/glm-5.3',
  limit: { kind: 'tokens', perDay: 5e6 },
  repos: { r1: { on: true, folders: ['src'] } },
  ...over,
});

describe('defaults', () => {
  it('defaultDreaming', () => {
    expect(defaultDreaming()).toEqual({
      enabled: false,
      model: null,
      testedModel: null,
      limit: null,
      repos: {},
      idleMinutes: 10,
    });
  });
  it('AppSettingsSchema fills dreaming', () => {
    expect(
      AppSettingsSchema.parse({ version: 1, receiverPort: 4318 }).dreaming,
    ).toEqual(defaultDreaming());
  });
});

describe('schema', () => {
  it.each(['../x', '/abs', ''])('rejects folder %j', (f) => {
    const r = DreamingSettingsSchema.safeParse(
      ready({ repos: { r1: { on: true, folders: [f] } } }),
    );
    expect(r.success).toBe(false);
  });
  it.each([
    '.',
    './x',
    'a/',
    'a//b',
    'a/.',
    'a/./b',
    'opencode.json',
    'OpenCode.jsonc',
    '.opencode',
    '.apm/.OpenCode/plugin',
    'src/opencode.json',
    'hooks',
    '.apm/hooks',
    '.apm/Hooks/format.json',
  ])('rejects folder %j as not a real sub-path', (f) => {
    const r = DreamingSettingsSchema.safeParse(
      ready({ repos: { r1: { on: true, folders: [f] } } }),
    );
    expect(r.success).toBe(false);
  });
  it.each(['AGENTS.md', '.apm', '.apm/skills', 'a/b.c'])(
    'accepts folder %j',
    (f) => {
      const r = DreamingSettingsSchema.safeParse(
        ready({ repos: { r1: { on: true, folders: [f] } } }),
      );
      expect(r.success).toBe(true);
    },
  );
  it('accepts a valid setting and rejects a bad model', () => {
    expect(DreamingSettingsSchema.safeParse(ready()).success).toBe(true);
    expect(
      DreamingSettingsSchema.safeParse(ready({ model: 'nope' })).success,
    ).toBe(false);
  });
});

describe('canSwitchOn', () => {
  it('names the first missing thing', () => {
    expect(canSwitchOn(defaultDreaming())).toBe('model');
    expect(canSwitchOn(ready({ testedModel: null }))).toBe('test');
    expect(canSwitchOn(ready({ testedModel: 'zai/other' }))).toBe('test');
    expect(canSwitchOn(ready({ limit: null }))).toBe('limit');
    expect(canSwitchOn(ready({ repos: {} }))).toBe('repos');
    expect(
      canSwitchOn(ready({ repos: { r: { on: true, folders: [] } } })),
    ).toBe('repos');
    expect(
      canSwitchOn(ready({ repos: { r: { on: false, folders: ['a'] } } })),
    ).toBe('repos');
    expect(canSwitchOn(ready())).toBeNull();
  });
});

describe('widens', () => {
  const base = ready();
  it('is true when more is sent or spent', () => {
    expect(
      widens(
        base,
        ready({ repos: { ...base.repos, r2: { on: true, folders: [] } } }),
      ),
    ).toBe(true);
    expect(
      widens(
        base,
        ready({ repos: { r1: { on: true, folders: ['src', 'lib'] } } }),
      ),
    ).toBe(true);
    expect(
      widens(base, ready({ limit: { kind: 'tokens', perDay: 6e6 } })),
    ).toBe(true);
    expect(widens(base, ready({ limit: { kind: 'none' } }))).toBe(true);
    expect(widens(base, ready({ limit: { kind: 'eur', perDay: 1 } }))).toBe(
      true,
    );
  });
  it('is false when less or unrelated changes', () => {
    expect(
      widens(base, ready({ repos: { r1: { on: false, folders: ['src'] } } })),
    ).toBe(false);
    expect(
      widens(base, ready({ repos: { r1: { on: true, folders: [] } } })),
    ).toBe(false);
    expect(
      widens(base, ready({ limit: { kind: 'tokens', perDay: 4e6 } })),
    ).toBe(false);
    expect(widens(base, ready({ idleMinutes: 30 }))).toBe(false);
  });
});

describe('widenings', () => {
  const base = ready();
  const names = (id: string) => (id === 'r1' ? 'Portal' : 'Billing');
  const cases: [string, DreamingSettings, string[]][] = [
    [
      'a repo added',
      ready({
        repos: {
          ...base.repos,
          r2: { on: true, folders: ['.apm', 'AGENTS.md'] },
        },
      }),
      ['Adds repo Billing, which may change .apm, AGENTS.md'],
    ],
    [
      'a repo switched on again',
      ready({
        repos: {
          r1: base.repos.r1,
          r2: { on: true, folders: ['x'] },
        },
      }),
      ['Adds repo Billing, which may change x'],
    ],
    [
      'folders added',
      ready({ repos: { r1: { on: true, folders: ['src', 'lib', 'docs'] } } }),
      ['Portal may now also change lib', 'Portal may now also change docs'],
    ],
    [
      'limit raised',
      ready({ limit: { kind: 'tokens', perDay: 6e6 } }),
      [
        'Raises the limit from up to 5 million tokens a day to up to 6 million tokens a day',
      ],
    ],
    [
      'limit removed',
      ready({ limit: { kind: 'none' } }),
      ['Removes the daily limit'],
    ],
    [
      'unit changed',
      ready({ limit: { kind: 'eur', perDay: 1 } }),
      [
        'Changes the limit from up to 5 million tokens a day to up to € 1.00 a day',
      ],
    ],
    ['narrowing', ready({ limit: { kind: 'tokens', perDay: 4e6 } }), []],
    ['unrelated', ready({ idleMinutes: 30 }), []],
    ['repo off', ready({ repos: { r1: { on: false, folders: ['src'] } } }), []],
  ];
  it.each(cases)('%s', (_n, next, lines) => {
    expect(widenings(base, next, names)).toEqual(lines);
    expect(widens(base, next)).toBe(lines.length > 0);
  });
  it('names a repo by its id without a name function', () => {
    expect(
      widenings(
        base,
        ready({ repos: { r1: { on: true, folders: ['src', 'a'] } } }),
      ),
    ).toEqual(['r1 may now also change a']);
  });
  it('names a change from no limit to a limit as such', () => {
    expect(
      widenings(
        ready({ limit: { kind: 'none' } }),
        ready({ limit: { kind: 'eur', perDay: 1 } }),
      ),
    ).toEqual(['Changes the limit from no limit to up to € 1.00 a day']);
  });
  it('sets a limit that was not chosen', () => {
    expect(widenings(ready({ limit: null }), base)).toEqual([
      'Sets the limit to up to 5 million tokens a day',
    ]);
  });
});

describe('confirmSentence', () => {
  const tail =
    " What was said in those repos' agent sessions is sent to that model.";
  it('reads in full', () => {
    expect(confirmSentence(ready(), ['Portal', 'Billing'])).toBe(
      'Dreams run on OpenCode with zai/glm-5.3, when this machine is idle, for 2 repos (Portal, Billing), up to 5 million tokens a day.' +
        tail,
    );
  });
  it('covers other limits and one repo', () => {
    expect(
      confirmSentence(ready({ limit: { kind: 'none' } }), ['Portal']),
    ).toContain('for 1 repo (Portal), with no limit.');
    expect(
      confirmSentence(ready({ limit: { kind: 'eur', perDay: 2 } }), ['Portal']),
    ).toContain('up to € 2.00 a day.');
    expect(
      confirmSentence(ready({ limit: { kind: 'tokens', perDay: 750000 } }), [
        'A',
      ]),
    ).toContain('up to 750 000 tokens a day.');
  });
});
