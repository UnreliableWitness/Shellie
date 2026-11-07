import type { BrainJob, BrainView } from '../../shared/brain';

export const brainView = (over: Partial<BrainView> = {}): BrainView => ({
  id: 'b1',
  name: 'Acme',
  connectionId: 'c1',
  project: 'Shellie',
  path: '/data/brains/b1',
  wiki: null,
  templatesVersion: 6,
  options: {
    contextInTaskMd: true,
    addDirForClaude: true,
    syncAfterRefresh: false,
    weeklyDigest: false,
    dailyTokenCap: 500_000,
    openBrainTerminalOnStart: false,
    model: 'sonnet',
    agent: 'claude',
    opencodeModel: null,
  },
  terminal: { id: 'bt1', kind: 'claude', label: 'Brain' },
  createdAt: '2026-11-01T09:00:00.000Z',
  lastRefreshAt: '2026-11-02T09:00:00.000Z',
  lastDigestAt: null,
  archived: false,
  picturePass: null,
  health: {
    state: {
      schemaVersion: 1,
      lastSyncCommit: null,
      lastLintAt: '2026-11-02T10:00:00.000Z',
      captured: {},
      findings: [
        {
          kind: 'orphan',
          page: 'wiki/a.md',
          detail: 'nothing links here',
          at: '2026-11-02T10:00:00.000Z',
        },
        {
          kind: 'stale',
          page: 'wiki/b.md',
          detail: 'older than its source',
          at: '2026-11-02T10:00:00.000Z',
        },
      ],
    },
    stateError: null,
    findings: [
      {
        kind: 'broken-link',
        page: 'wiki/a.md',
        detail: '../sources/gone.md does not exist',
        at: '2026-11-02T10:00:00.000Z',
      },
      {
        kind: 'contradiction',
        page: 'wiki/b.md',
        detail: 'disagrees with wiki/c.md on the go-live date',
        at: '2026-11-02T10:00:00.000Z',
      },
    ],
    pages: 7,
    uncaptured: 3,
    mirrorPages: 12,
    outsideEdits: [],
    queuePaused: null,
    queueHeld: null,
    costEurToday: 0.42,
    tokensToday: 12_345,
    pictures: {
      total: 0,
      described: 0,
      skipped: 0,
      missing: 0,
      dropped: 0,
      accepted: 0,
      tiny: 0,
    },
  },
  jobs: [],
  ...over,
});

/** A brain as `brain:list` and `brain:forTask` answer: without health (only `brain:get` has it). */
export const listedBrain = (over: Partial<BrainView> = {}): BrainView =>
  brainView({ health: null, ...over });

export const brainJob = (over: Partial<BrainJob> = {}): BrainJob => ({
  id: 'j1',
  brainId: 'b1',
  kind: 'capture',
  source: 'sources/kickoff.vtt',
  status: 'failed',
  startedAt: '2026-11-02T10:00:00.000Z',
  endedAt: '2026-11-02T10:01:00.000Z',
  sessionId: 's-1',
  result: null,
  error: 'claude exited 1',
  background: false,
  agent: 'claude',
  ...over,
});
