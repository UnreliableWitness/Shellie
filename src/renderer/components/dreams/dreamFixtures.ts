import {
  defaultDreaming,
  type DreamingSettings,
  type DreamJournalEntry,
  type DreamRepoState,
  type DreamResult,
  type DreamView,
} from '../../../shared/dreams';

export const MODEL = 'zai/glm-5.3';

export const settings = (
  patch: Partial<DreamingSettings> = {},
): DreamingSettings => ({
  ...defaultDreaming(),
  enabled: true,
  model: MODEL,
  testedModel: MODEL,
  limit: { kind: 'tokens', perDay: 5_000_000 },
  repos: {
    r1: { on: true, folders: ['.apm'] },
    r2: { on: true, folders: ['.apm', 'AGENTS.md'] },
  },
  ...patch,
});

export const emptyState = (
  patch: Partial<DreamRepoState> = {},
): DreamRepoState => ({
  covered: {},
  sightings: [],
  rejections: [],
  failures: 0,
  lastFailureAt: null,
  lastFailure: null,
  lastDreamAt: null,
  lastOutcome: null,
  result: null,
  ...patch,
});

export const result = (
  id: string,
  repoId: string,
  titles: string[],
  patch: Partial<DreamResult> = {},
): DreamResult => ({
  id,
  repoId,
  branch: `dream/2026-11-20-${id}`,
  baseSha: 'abc',
  worktreePath: '/tmp/w',
  dataDir: '/tmp/d',
  at: '2026-11-20T03:12:00',
  model: MODEL,
  tokens: 790_000,
  sessions: 6,
  proposals: titles.map((title, i) => ({
    id: `${id}-${i}`,
    kind: 'new-rule',
    title,
    why: 'because',
    evidence: [],
    files: [],
    commit: 'c',
    dropped: false,
  })),
  reverted: [],
  removedByCheck: 0,
  ...patch,
});

export const journalEntry = (
  patch: Partial<DreamJournalEntry> = {},
): DreamJournalEntry => ({
  dreamId: 'd1',
  repoId: 'r1',
  at: '2026-11-20T03:12:00',
  model: MODEL,
  tokens: 790_000,
  outcome: 'proposed',
  reason: null,
  proposals: 2,
  removedByCheck: 0,
  closed: null,
  ...patch,
});

export const viewOf = (patch: Partial<DreamView> = {}): DreamView => ({
  settings: settings(),
  models: [MODEL],
  euroLimitOffered: false,
  usage: { day: '2026-11-20', tokens: 1_200_000, eur: 0.4 },
  waiting: 'active',
  next: null,
  running: null,
  switchedOff: null,
  repos: [
    {
      id: 'r1',
      name: 'portal',
      suggestedFolders: ['.apm'],
      newSessions: 0,
      state: emptyState(),
    },
    {
      id: 'r2',
      name: 'billing',
      suggestedFolders: ['.apm'],
      newSessions: 0,
      state: emptyState(),
    },
    {
      id: 'r3',
      name: 'intranet',
      suggestedFolders: [],
      newSessions: 0,
      state: emptyState(),
    },
  ],
  journal: [],
  ...patch,
});

/** `viewOf` with an open result on portal (two proposals) and billing (one). */
export const withResults = (patch: Partial<DreamView> = {}): DreamView => {
  const v = viewOf(patch);
  v.repos[0].state = emptyState({
    result: result('a', 'r1', [
      'New rule: write migrations by hand',
      'Skill: release notes',
    ]),
  });
  v.repos[1].state = emptyState({
    result: result('b', 'r2', ['New skill: run the VAT test set'], {
      at: '2026-11-20T03:41:00',
    }),
  });
  return v;
};
