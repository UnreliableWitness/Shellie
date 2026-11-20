import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import type {
  DreamFileDiff,
  DreamingSettings,
  DreamJournalEntry,
  DreamProposal,
  DreamResult,
} from '../../shared/dreams';
import { GitClient } from '../services/GitClient';
import { ExitError } from '../services/prSummary';
import { SettingsStore } from '../usage/SettingsStore';
import {
  cleanupTempRepos,
  commitFile,
  git,
  makeRepo,
} from '../test-helpers/gitRepo';
import { testPlatform } from '../test-helpers/shell';
import { commitFiles } from './dreamGit';
import {
  createDreamHandlers,
  DREAM_TEST_PROMPT,
  DREAM_TEST_TIMEOUT_MS,
  type DreamHandlerDeps,
} from './dreamHandlers';
import { DreamStore } from './DreamStore';
import { opencodeModelList } from './models';
import { dreamArgs } from './opencodeDream';
import type { DreamStatus } from './scheduler';

const MODEL = 'zai/glm-5';
const OTHER = 'zai/glm-6';
const DREAM_ID = '2026-11-20-1';
const BRANCH = `dream/${DREAM_ID}`;
const MISMATCH_PHRASE = "The dream's record does not match its folder";

let dir: string;
let repoPath: string;
let settings: SettingsStore;
let store: DreamStore;
let status: DreamStatus;
type Scheduler = NonNullable<ReturnType<DreamHandlerDeps['scheduler']>>;
let scheduler: { [K in keyof Scheduler]: Mock<Scheduler[K]> };
let started: boolean;
let deps: DreamHandlerDeps;
let run: Mock;
let answered: string[];
/** `opencode models`, as the shared list asks it. */
let askModels: Mock<() => Promise<string[] | null>>;

const ready = (over: Partial<DreamingSettings> = {}): DreamingSettings => ({
  enabled: false,
  model: MODEL,
  testedModel: MODEL,
  limit: { kind: 'tokens', perDay: 1_000_000 },
  repos: { r1: { on: true, folders: ['.apm'] } },
  idleMinutes: 10,
  ...over,
});

const setDreaming = (d: DreamingSettings) => settings.updateDreaming(() => d);

const entry = (dreamId: string, at: string): DreamJournalEntry => ({
  dreamId,
  repoId: 'r1',
  at,
  model: MODEL,
  tokens: 10,
  outcome: 'proposed',
  reason: null,
  proposals: 3,
  removedByCheck: 0,
  closed: null,
});

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'dream-ipc-')));
  repoPath = makeRepo('portal');
  settings = new SettingsStore(path.join(dir, 'settings.json'));
  await settings.load();
  store = new DreamStore(dir);
  await store.load();
  status = {
    wait: 'active',
    next: { repoId: 'r1', newSessions: 2 },
    switchedOff: null,
    running: null,
    newSessions: { r1: 2 },
  };
  scheduler = {
    dreamNow: vi.fn<Scheduler['dreamNow']>(async () => ({ started: true })),
    stopDream: vi.fn(),
    stopDreamOf: vi.fn(async () => undefined),
    status: vi.fn(() => status),
    switchOn: vi.fn(async (save: () => Promise<void>) => {
      await save();
      await store.setSwitchedOff(null);
    }),
  };
  started = true;
  answered = [MODEL];
  askModels = vi.fn(async () => [MODEL, OTHER]);
  run = vi.fn(
    async () =>
      `${JSON.stringify({ type: 'step_start', sessionID: 'ses_1' })}\n`,
  );
  deps = {
    settings,
    store,
    scheduler: () => (started ? scheduler : null),
    repos: () => [{ id: 'r1', name: 'Portal', path: repoPath }],
    git: new GitClient(),
    platform: testPlatform(),
    run: run as unknown as DreamHandlerDeps['run'],
    sessionModels: vi.fn(() => answered),
    models: opencodeModelList({ ask: () => askModels(), now: Date.now }),
    usage: () => ({ day: '2026-11-20', tokens: 42, eur: 0.5 }),
    dreamsDir: path.join(dir, 'dreams'),
    broadcast: vi.fn(),
  };
});

afterEach(() => cleanupTempRepos());

const api = () => createDreamHandlers(deps);
const changed = () => vi.mocked(deps.broadcast).mock.calls.length;

/** A dream result of three proposals, each a commit of one file in .apm/rules, on a real dream worktree. */
async function dreamWithThree(
  o: { thirdEditsSecond?: boolean } = {},
): Promise<DreamResult> {
  const dreamDir = path.join(deps.dreamsDir, 'r1', DREAM_ID);
  mkdirSync(path.join(dreamDir, 'data'), { recursive: true });
  mkdirSync(path.join(dreamDir, 'hooks'));
  const baseSha = git(repoPath, 'rev-parse', 'HEAD').trim();
  git(
    repoPath,
    'worktree',
    'add',
    '-q',
    '-b',
    BRANCH,
    path.join(dreamDir, 'wt'),
    'main',
  );
  const wt = realpathSync(path.join(dreamDir, 'wt'));
  mkdirSync(path.join(wt, '.apm', 'rules'), { recursive: true });
  const g = new GitClient();
  const proposals: DreamProposal[] = [];
  const files = ['a.md', 'b.md', o.thirdEditsSecond ? 'b.md' : 'c.md'];
  for (const [i, f] of files.entries()) {
    const file = `.apm/rules/${f}`;
    writeFileSync(path.join(wt, file), `rule ${i + 1}\n`);
    const commit = await commitFiles(g, wt, {
      files: [file],
      subject: `dream: Rule ${i + 1}`,
      body: '',
      config: [],
    });
    proposals.push({
      id: `p${i + 1}`,
      kind: 'new-rule',
      title: `Rule ${i + 1}`,
      why: `Why ${i + 1}`,
      evidence: [],
      files: [file],
      commit,
      dropped: false,
    });
  }
  const result: DreamResult = {
    id: DREAM_ID,
    repoId: 'r1',
    branch: BRANCH,
    baseSha,
    worktreePath: wt,
    dataDir: realpathSync(path.join(dreamDir, 'data')),
    at: '2026-11-20T03:00:00.000Z',
    model: MODEL,
    tokens: 100,
    sessions: 2,
    proposals,
    reverted: [],
    removedByCheck: 0,
  };
  await store.setResult('r1', result);
  await store.log(entry(DREAM_ID, result.at));
  return result;
}

describe('dream:get', () => {
  it('returns the settings, what the scheduler knows, each repo with its sessions, and the journal newest first', async () => {
    mkdirSync(path.join(repoPath, '.apm'));
    await store.log(entry('2026-11-19-1', '2026-11-19T03:00:00.000Z'));
    await store.log(entry('2026-11-20-1', '2026-11-20T03:00:00.000Z'));
    // What the scheduler or another screen already read.
    await deps.models.get();
    const view = await api().handlers['dream:get']();
    expect(view.journal.map((e) => e.dreamId)).toEqual([
      '2026-11-20-1',
      '2026-11-19-1',
    ]);
    expect(view.repos).toEqual([
      expect.objectContaining({
        id: 'r1',
        name: 'Portal',
        suggestedFolders: ['.apm'],
        newSessions: 2,
      }),
    ]);
    expect(view).toMatchObject({
      waiting: 'active',
      next: { repoId: 'r1', newSessions: 2 },
      usage: { tokens: 42 },
      models: [MODEL, OTHER],
      euroLimitOffered: false,
      settings: settings.get().dreaming,
    });
  });

  it('never starts a process: with dreaming off and no OpenCode installed, four in a row spawn nothing', async () => {
    askModels.mockResolvedValue(null);
    const h = api().handlers;
    for (let i = 0; i < 4; i++)
      expect((await h['dream:get']()).models).toBeNull();
    expect(askModels).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('answers before the scheduler started: dreaming as stored, no wait, no sessions known', async () => {
    started = false;
    const view = await api().handlers['dream:get']();
    expect(view.waiting).toBeNull();
    expect(view.next).toBeNull();
    expect(view.repos[0]).toMatchObject({
      newSessions: 0,
      suggestedFolders: [],
    });
  });
});

describe('dream:switchOn', () => {
  it.each([
    ['model', { model: null, testedModel: null }],
    ['test', { testedModel: OTHER }],
    ['limit', { limit: null }],
    ['repos', { repos: { r1: { on: false, folders: ['.apm'] } } }],
  ] as const)('refuses while %s is missing', async (reason, over) => {
    await setDreaming(ready(over as Partial<DreamingSettings>));
    await expect(api().handlers['dream:switchOn'](true)).rejects.toThrow(
      `Dreaming cannot be switched on yet: ${reason}`,
    );
    expect(settings.get().dreaming.enabled).toBe(false);
    expect(changed()).toBe(0);
  });

  it('switches on with all four and the tick, through the scheduler, clearing a switch-off', async () => {
    await setDreaming(ready());
    await store.setSwitchedOff({
      answered: 'a/b',
      chosen: MODEL,
      repoId: 'r1',
    });
    const saved = await api().handlers['dream:switchOn'](true);
    expect(saved.enabled).toBe(true);
    expect(settings.get().dreaming.enabled).toBe(true);
    expect(scheduler.switchOn).toHaveBeenCalledOnce();
    expect(store.switchedOff()).toBeNull();
    expect(changed()).toBe(1);
  });

  it('never switches on without the tick', async () => {
    await setDreaming(ready());
    await expect(api().handlers['dream:switchOn'](false)).rejects.toThrow(
      'Tick the box first',
    );
    await setDreaming(ready({ model: null }));
    await expect(api().handlers['dream:switchOn'](false)).rejects.toThrow();
    expect(settings.get().dreaming.enabled).toBe(false);
    expect(scheduler.switchOn).not.toHaveBeenCalled();
  });

  it('refuses before the scheduler started', async () => {
    await setDreaming(ready());
    started = false;
    await expect(api().handlers['dream:switchOn'](true)).rejects.toThrow(
      'Dreams are still starting',
    );
    expect(settings.get().dreaming.enabled).toBe(false);
  });

  it('switchOff saves off and stops a running dream', async () => {
    await setDreaming(ready({ enabled: true }));
    expect((await api().handlers['dream:switchOff']()).enabled).toBe(false);
    expect(settings.get().dreaming.enabled).toBe(false);
    expect(scheduler.stopDream).toHaveBeenCalled();
    expect(changed()).toBe(1);
  });
});

describe('dream:save', () => {
  const wider = (d: DreamingSettings): DreamingSettings => ({
    ...d,
    repos: { r1: { on: true, folders: ['.apm', 'AGENTS.md'] } },
  });

  it('applies a narrowing change while on without the tick', async () => {
    await setDreaming(ready({ enabled: true }));
    const next = {
      ...ready({ enabled: true }),
      limit: { kind: 'tokens' as const, perDay: 10 },
    };
    expect((await api().handlers['dream:save'](next, false)).limit).toEqual(
      next.limit,
    );
    expect(settings.get().dreaming.enabled).toBe(true);
    expect(changed()).toBe(1);
  });

  it('refuses a widening change while on without the tick, and applies it with the tick', async () => {
    await setDreaming(ready({ enabled: true }));
    const next = wider(ready({ enabled: true }));
    await expect(api().handlers['dream:save'](next, false)).rejects.toThrow(
      'Confirm the change first',
    );
    expect(settings.get().dreaming.repos.r1.folders).toEqual(['.apm']);
    await api().handlers['dream:save'](next, true);
    expect(settings.get().dreaming.repos.r1.folders).toEqual([
      '.apm',
      'AGENTS.md',
    ]);
  });

  it('a narrowing change that leaves nothing to dream switches dreaming off in the same write', async () => {
    await setDreaming(ready({ enabled: true }));
    const saved = await api().handlers['dream:save'](
      {
        ...ready({ enabled: true }),
        repos: { r1: { on: false, folders: ['.apm'] } },
      },
      false,
    );
    expect(saved.enabled).toBe(false);
    expect(settings.get().dreaming.enabled).toBe(false);
    expect(changed()).toBe(1);
  });

  it('a narrowing change that unticks the repo a dream runs for stops that dream', async () => {
    await setDreaming(
      ready({
        enabled: true,
        repos: {
          r1: { on: true, folders: ['.apm'] },
          r2: { on: true, folders: ['.apm'] },
        },
      }),
    );
    deps.repos = () => [
      { id: 'r1', name: 'Portal', path: repoPath },
      { id: 'r2', name: 'Billing', path: repoPath },
    ];
    status = {
      ...status,
      running: { repoId: 'r1', startedAt: 1, step: 'reading' },
    };
    const h = api().handlers;
    await h['dream:save'](
      { ...settings.get().dreaming, limit: { kind: 'tokens', perDay: 10 } },
      false,
    );
    expect(scheduler.stopDream).not.toHaveBeenCalled();
    const saved = await h['dream:save'](
      {
        ...settings.get().dreaming,
        repos: {
          r1: { on: false, folders: ['.apm'] },
          r2: { on: true, folders: ['.apm'] },
        },
      },
      false,
    );
    expect(saved.enabled).toBe(true);
    expect(scheduler.stopDream).toHaveBeenCalledOnce();
  });

  it('a narrowing change that switches dreaming off stops a running dream', async () => {
    await setDreaming(ready({ enabled: true }));
    await api().handlers['dream:save'](
      {
        ...ready({ enabled: true }),
        repos: { r1: { on: false, folders: ['.apm'] } },
      },
      false,
    );
    expect(scheduler.stopDream).toHaveBeenCalledOnce();
  });

  it('says a settings write failure in a fixed phrase', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await setDreaming(ready({ enabled: true }));
    vi.spyOn(settings, 'updateDreaming').mockRejectedValueOnce(
      new Error(`ENOSPC: no space left, write '${dir}/settings.json'`),
    );
    await expect(api().handlers['dream:switchOff']()).rejects.toThrow(
      /^The dream settings could not be saved$/,
    );
  });

  it('applies a widening change while off without the tick', async () => {
    await setDreaming(ready());
    await api().handlers['dream:save'](wider(ready()), false);
    expect(settings.get().dreaming.repos.r1.folders).toEqual([
      '.apm',
      'AGENTS.md',
    ]);
  });

  it('never takes enabled, model or testedModel, and drops repos Shellie does not know', async () => {
    await setDreaming(ready());
    const saved = await api().handlers['dream:save'](
      {
        ...ready(),
        enabled: true,
        model: OTHER,
        testedModel: OTHER,
        repos: {
          r1: { on: true, folders: ['.apm'] },
          gone: { on: true, folders: ['x'] },
        },
      },
      true,
    );
    expect(saved).toMatchObject({
      enabled: false,
      model: MODEL,
      testedModel: MODEL,
    });
    expect(Object.keys(saved.repos)).toEqual(['r1']);
    expect(settings.get().dreaming).toEqual(saved);
  });

  it.each(['.', '/etc', 'a/../b', '.opencode/agent'])(
    'refuses %s as a folder',
    async (folder) => {
      await setDreaming(ready());
      await expect(
        api().handlers['dream:save'](
          { ...ready(), repos: { r1: { on: true, folders: [folder] } } },
          true,
        ),
      ).rejects.toThrow('These dream settings are not valid');
      expect(changed()).toBe(0);
    },
  );
});

describe('dream:test', () => {
  it('passes when only the model answered: one call with the dream args and env, in an empty folder removed afterwards', async () => {
    await setDreaming(ready({ model: null, testedModel: null }));
    let inFolder: string[] = [];
    run.mockImplementation(async (_cmd, o: { cwd: string }) => {
      inFolder = readdirSync(o.cwd);
      return `${JSON.stringify({ sessionID: 'ses_1' })}\n`;
    });
    expect(await api().handlers['dream:test'](MODEL)).toEqual({ ok: true });
    expect(run).toHaveBeenCalledOnce();
    const [cmd, o] = run.mock.calls[0] as [
      { args: string[] },
      {
        cwd: string;
        env: Record<string, string>;
        input: string;
        timeoutMs: number;
      },
    ];
    const cwdHeld = o.cwd;
    expect(inFolder).toEqual([]);
    expect(cmd.args).toEqual(
      deps.platform.opencodeCommand(undefined, dreamArgs(MODEL, 'test')).args,
    );
    expect(o.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(JSON.parse(o.env.OPENCODE_CONFIG_CONTENT).small_model).toBe(MODEL);
    expect(o.input).toBe(DREAM_TEST_PROMPT);
    expect(o.timeoutMs).toBe(DREAM_TEST_TIMEOUT_MS);
    expect(deps.sessionModels).toHaveBeenCalledWith('ses_1');
    // Under the dreams folder, so the ledger knows its usage as a dream's and never sends it.
    expect(path.relative(deps.dreamsDir, cwdHeld)).toMatch(
      /^\.test-[^/\\]+[/\\]wt$/,
    );
    expect(existsSync(path.dirname(cwdHeld!))).toBe(false);
    expect(settings.get().dreaming).toMatchObject({
      model: MODEL,
      testedModel: MODEL,
    });
    expect(changed()).toBe(1);
  });

  it('a re-test of the saved model that another model answered does what a wrong-model dream does', async () => {
    await setDreaming(ready({ enabled: true }));
    status = {
      ...status,
      running: { repoId: 'r1', startedAt: 1, step: 'reading' },
    };
    const events: [string, unknown][] = [];
    deps.event = (name, props) => events.push([name, props]);
    answered = [MODEL, 'anthropic/claude-x'];
    expect(await api().handlers['dream:test'](MODEL)).toEqual({
      ok: false,
      message: 'Another model answered',
    });
    expect(settings.get().dreaming).toMatchObject({
      enabled: false,
      model: MODEL,
      testedModel: null,
    });
    expect(store.switchedOff()).toEqual({
      answered: 'anthropic/claude-x',
      chosen: MODEL,
      repoId: '',
    });
    expect(scheduler.stopDream).toHaveBeenCalled();
    expect(events).toContainEqual([
      'dream.switched_off',
      { by: 'wrong-model' },
    ]);
    expect(changed()).toBe(1);
  });

  it.each([
    ['did not answer', () => run.mockResolvedValueOnce('no events at all')],
    [
      'timed out',
      () =>
        run.mockRejectedValueOnce(new Error('opencode timed out after 120 s')),
    ],
    [
      'OpenCode was not found',
      () =>
        run.mockRejectedValueOnce(
          Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }),
        ),
    ],
    ['not in the list', () => askModels.mockResolvedValue([OTHER])],
  ])(
    'any other failed re-test of the saved model (%s) forgets the test and switches dreaming off, without a record',
    async (_why, fail) => {
      await setDreaming(ready({ enabled: true }));
      const events: [string, unknown][] = [];
      deps.event = (name, props) => events.push([name, props]);
      fail();
      expect((await api().handlers['dream:test'](MODEL)).ok).toBe(false);
      expect(settings.get().dreaming).toMatchObject({
        enabled: false,
        testedModel: null,
      });
      expect(store.switchedOff()).toBeNull();
      expect(scheduler.stopDream).toHaveBeenCalled();
      expect(events).toContainEqual([
        'dream.switched_off',
        { by: 'test-failed' },
      ]);
    },
  );

  it('a failed test of a model that is not the saved one changes nothing', async () => {
    await setDreaming(ready({ enabled: true }));
    answered = [OTHER, 'anthropic/claude-x'];
    expect(await api().handlers['dream:test'](OTHER)).toMatchObject({
      ok: false,
    });
    expect(settings.get().dreaming).toMatchObject({
      enabled: true,
      model: MODEL,
      testedModel: MODEL,
    });
    expect(store.switchedOff()).toBeNull();
    expect(scheduler.stopDream).not.toHaveBeenCalled();
    expect(changed()).toBe(0);
  });

  it('a passed test of a new model switches dreaming off and stops a dream still running on the old one', async () => {
    await setDreaming(ready({ enabled: true }));
    answered = [OTHER];
    expect(await api().handlers['dream:test'](OTHER)).toEqual({ ok: true });
    expect(settings.get().dreaming.enabled).toBe(false);
    expect(scheduler.stopDream).toHaveBeenCalled();
  });

  it('testing a new model while on switches dreaming off', async () => {
    await setDreaming(ready({ enabled: true }));
    expect(await api().handlers['dream:test'](OTHER)).toEqual({
      ok: false,
      message: 'Another model answered',
    });
    answered = [OTHER];
    expect(await api().handlers['dream:test'](OTHER)).toEqual({ ok: true });
    expect(settings.get().dreaming).toMatchObject({
      enabled: false,
      model: OTHER,
      testedModel: OTHER,
    });
  });

  it('testing the same model again while on keeps dreaming on', async () => {
    await setDreaming(ready({ enabled: true }));
    expect(await api().handlers['dream:test'](MODEL)).toEqual({ ok: true });
    expect(settings.get().dreaming.enabled).toBe(true);
  });

  it('refuses a model not in OpenCode’s list before any call', async () => {
    expect(await api().handlers['dream:test']('zai/unknown')).toEqual({
      ok: false,
      message: 'zai/unknown is not available in OpenCode',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('says why in a fixed phrase, never the run’s output', async () => {
    const h = api().handlers;
    run.mockRejectedValueOnce(
      Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }),
    );
    expect(await h['dream:test'](MODEL)).toEqual({
      ok: false,
      message: 'OpenCode was not found',
    });
    run.mockRejectedValueOnce(new Error('opencode timed out after 120 s'));
    expect(await h['dream:test'](MODEL)).toEqual({
      ok: false,
      message: 'The test timed out',
    });
    run.mockRejectedValueOnce(
      new ExitError('secret session text', 1, 'secret'),
    );
    expect(await h['dream:test'](MODEL)).toEqual({
      ok: false,
      message: `${MODEL} did not answer`,
    });
    run.mockResolvedValueOnce('no events at all');
    expect(await h['dream:test'](MODEL)).toEqual({
      ok: false,
      message: `${MODEL} did not answer`,
    });
  });

  it('says a test folder that cannot be made in a fixed phrase', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(path.join(dir, 'not-a-folder'), '');
    deps.dreamsDir = path.join(dir, 'not-a-folder', 'dreams');
    expect(await api().handlers['dream:test'](MODEL)).toEqual({
      ok: false,
      message: 'The test could not be run',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs one test at a time', async () => {
    let finish!: (s: string) => void;
    run.mockImplementationOnce(() => new Promise<string>((r) => (finish = r)));
    const h = api().handlers;
    const first = h['dream:test'](MODEL);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    expect(await h['dream:test'](MODEL)).toEqual({
      ok: false,
      message: 'A test is already running',
    });
    finish(`${JSON.stringify({ sessionID: 'ses_1' })}\n`);
    expect(await first).toEqual({ ok: true });
  });
});

describe('dream:now and dream:stop', () => {
  it('Dream now answers what the scheduler decided', async () => {
    scheduler.dreamNow.mockResolvedValueOnce({ wait: 'limit' });
    expect(await api().handlers['dream:now']('r1')).toEqual({ wait: 'limit' });
    expect(await api().handlers['dream:now']('r1')).toEqual({ started: true });
    await api().handlers['dream:stop']();
    expect(scheduler.stopDream).toHaveBeenCalled();
  });
});

describe('a dream result', () => {
  const tree = (ref: string) =>
    git(repoPath, 'ls-tree', '-r', '--name-only', ref).trim().split('\n');
  const subjects = (from: string, to: string) =>
    git(repoPath, 'log', '--format=%s', '--reverse', `${from}..${to}`)
      .trim()
      .split('\n');

  it('drop marks a proposal, undo takes it back; an unknown one is refused', async () => {
    await dreamWithThree();
    const h = api().handlers;
    await h['dream:drop']('r1', 'p2', true);
    expect(store.repo('r1').result!.proposals[1].dropped).toBe(true);
    await h['dream:drop']('r1', 'p2', false);
    expect(store.repo('r1').result!.proposals[1].dropped).toBe(false);
    expect(changed()).toBe(2);
    await expect(h['dream:drop']('r1', 'p9', true)).rejects.toThrow(
      'This dream has no such proposal',
    );
  });

  it('open as task with proposal 2 of 3 dropped leaves a branch of commits 1 and 3 without 2’s change', async () => {
    const r = await dreamWithThree();
    const a = api();
    await a.handlers['dream:drop']('r1', 'p2', true);
    vi.mocked(deps.broadcast).mockClear();
    expect(await a.handlers['dream:openAsTask']('r1')).toEqual({
      branch: BRANCH,
    });
    expect(subjects(r.baseSha, BRANCH)).toEqual([
      'dream: Rule 1',
      'dream: Rule 3',
    ]);
    expect(tree(BRANCH)).toContain('.apm/rules/a.md');
    expect(tree(BRANCH)).toContain('.apm/rules/c.md');
    expect(tree(BRANCH)).not.toContain('.apm/rules/b.md');
    expect(existsSync(r.worktreePath)).toBe(false);
    expect(existsSync(r.dataDir)).toBe(false);
    expect(git(repoPath, 'worktree', 'list')).not.toContain(DREAM_ID);
    const state = store.repo('r1');
    expect(state.result).toBeNull();
    expect(state.rejections.map((x) => x.title)).toEqual(['Rule 2']);
    expect(store.journal()[0].closed).toEqual({
      as: 'task',
      kept: 2,
      dropped: 1,
      taskName: null,
    });
    expect(changed()).toBe(1);
    // The pair, for tasks:create: this branch only, used up once the task is made.
    expect(a.taskLink.opened(DREAM_ID, 'r1', BRANCH)).toBe(true);
    expect(a.taskLink.opened(DREAM_ID, 'r1', 'dream/other')).toBe(false);
    expect(a.taskLink.opened(DREAM_ID, 'r2', BRANCH)).toBe(false);
    await a.taskLink.taskCreated(DREAM_ID, 'r1', 'Rules from a dream');
    expect(store.journal()[0].closed).toEqual({
      as: 'task',
      kept: 2,
      dropped: 1,
      taskName: 'Rules from a dream',
    });
    expect(a.taskLink.opened(DREAM_ID, 'r1', BRANCH)).toBe(false);
  });

  it('passes core.longpaths=true to every git call it makes in the worktree or with hooks off', async () => {
    const g = deps.git as GitClient;
    const spy = vi.spyOn(g, 'run');
    await dreamWithThree();
    const h = api().handlers;
    await h['dream:drop']('r1', 'p2', true);
    await h['dream:diff']('r1', 'p1');
    await h['dream:openAsTask']('r1');
    git(repoPath, 'branch', '-D', BRANCH);
    await dreamWithThree();
    await h['dream:discard']('r1');
    const calls = spy.mock.calls.map(([cwd, args]) => ({ cwd, args }));
    const own = calls.filter(
      (c) =>
        !path.relative(deps.dreamsDir, c.cwd).startsWith('..') ||
        c.args.some((a) => a.startsWith('core.hooksPath=')),
    );
    // checked, built, rebuild, the diff, and the branch deleted on discard.
    for (const cmd of [
      'symbolic-ref',
      'merge-base',
      'cherry-pick',
      'diff-tree',
    ])
      expect(
        own.some((c) => c.args.includes(cmd)),
        cmd,
      ).toBe(true);
    expect(own.some((c) => c.args.includes('-D'))).toBe(true);
    for (const c of own)
      expect(c.args, c.args.join(' ')).toContain('core.longpaths=true');
  });

  it('open as task finishes on a second call when removing the worktree failed after the rebuild', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await dreamWithThree();
    const g = deps.git as GitClient;
    const a = api();
    await a.handlers['dream:drop']('r1', 'p2', true);
    vi.spyOn(g, 'worktreePrune').mockRejectedValueOnce(new Error('locked'));
    await expect(a.handlers['dream:openAsTask']('r1')).rejects.toThrow(
      'The dream could not be opened as a task',
    );
    const rebuilt = git(repoPath, 'rev-parse', BRANCH).trim();
    expect(subjects(r.baseSha, BRANCH)).toEqual([
      'dream: Rule 1',
      'dream: Rule 3',
    ]);
    expect(store.repo('r1').result).not.toBeNull();
    expect(await a.handlers['dream:openAsTask']('r1')).toEqual({
      branch: BRANCH,
    });
    // Not built again: the branch is the one the first call made.
    expect(git(repoPath, 'rev-parse', BRANCH).trim()).toBe(rebuilt);
    expect(git(repoPath, 'worktree', 'list')).not.toContain(DREAM_ID);
    expect(store.repo('r1').result).toBeNull();
    expect(store.repo('r1').rejections.map((x) => x.title)).toEqual(['Rule 2']);
    expect(a.taskLink.opened(DREAM_ID, 'r1', BRANCH)).toBe(true);
  });

  it('open as task with nothing dropped keeps the dream’s own commits', async () => {
    const r = await dreamWithThree();
    const tip = git(repoPath, 'rev-parse', BRANCH).trim();
    await api().handlers['dream:openAsTask']('r1');
    expect(git(repoPath, 'rev-parse', BRANCH).trim()).toBe(tip);
    expect(subjects(r.baseSha, BRANCH)).toHaveLength(3);
  });

  it('closes only this repo’s journal entry when another repo has a dream of the same id', async () => {
    await dreamWithThree();
    await store.log({
      ...entry(DREAM_ID, '2026-11-20T04:00:00.000Z'),
      repoId: 'r2',
    });
    await api().handlers['dream:discard']('r1');
    const j = store.journal();
    expect(j.find((e) => e.repoId === 'r2')?.closed).toBeNull();
    expect(j.find((e) => e.repoId === 'r1')?.closed).toMatchObject({
      as: 'discarded',
    });
  });

  it('remembers the opened branch in the store, with no time limit and across a restart, until the task is made', async () => {
    let t = 1_000_000;
    deps.now = () => t;
    await dreamWithThree();
    await api().handlers['dream:drop']('r1', 'p2', true);
    await api().handlers['dream:openAsTask']('r1');
    expect(store.repo('r1')).toMatchObject({
      result: null,
      opened: {
        dreamId: DREAM_ID,
        branch: BRANCH,
        kept: 2,
        titles: ['Rule 1', 'Rule 3'],
      },
    });
    t += 24 * 60 * 60_000;
    // A restart: new handlers on the same file.
    const again = new DreamStore(dir);
    await again.load();
    const after = createDreamHandlers({ ...deps, store: again });
    expect(after.taskLink.opened(DREAM_ID, 'r1', BRANCH)).toBe(true);
    expect(after.taskLink.opened(DREAM_ID, 'r1', 'dream/other')).toBe(false);
    expect(after.taskLink.opened('2026-11-20-9', 'r1', BRANCH)).toBe(false);
    expect(after.taskLink.opened(DREAM_ID, 'r2', BRANCH)).toBe(false);
    await after.taskLink.taskCreated(DREAM_ID, 'r1', 'Rules from a dream');
    expect(again.repo('r1').opened).toBeNull();
    expect(after.taskLink.opened(DREAM_ID, 'r1', BRANCH)).toBe(false);
    expect(again.journal()[0].closed).toEqual({
      as: 'task',
      kept: 2,
      dropped: 1,
      taskName: 'Rules from a dream',
    });
  });

  it('Leave the branch forgets the opened record and keeps the branch', async () => {
    await dreamWithThree();
    const a = api();
    await a.handlers['dream:openAsTask']('r1');
    const tip = git(repoPath, 'rev-parse', BRANCH).trim();
    vi.mocked(deps.broadcast).mockClear();
    await a.handlers['dream:leaveBranch']('r1');
    expect(store.repo('r1').opened).toBeNull();
    expect(a.taskLink.opened(DREAM_ID, 'r1', BRANCH)).toBe(false);
    expect(git(repoPath, 'rev-parse', BRANCH).trim()).toBe(tip);
    expect(changed()).toBe(1);
    await expect(a.handlers['dream:leaveBranch']('r1')).rejects.toThrow(
      'This repo has no dream branch waiting for a task',
    );
  });

  it('a cherry-pick that fails puts the branch back and removes nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await dreamWithThree({ thirdEditsSecond: true });
    const tip = git(repoPath, 'rev-parse', BRANCH).trim();
    const a = api();
    await a.handlers['dream:drop']('r1', 'p2', true);
    await expect(a.handlers['dream:openAsTask']('r1')).rejects.toThrow(
      'The dream could not be opened as a task',
    );
    expect(git(repoPath, 'rev-parse', BRANCH).trim()).toBe(tip);
    expect(git(r.worktreePath, 'status', '--porcelain')).toBe('');
    expect(existsSync(r.dataDir)).toBe(true);
    expect(store.repo('r1').result).not.toBeNull();
    expect(store.repo('r1').rejections).toEqual([]);
    expect(a.taskLink.opened(DREAM_ID, 'r1', BRANCH)).toBe(false);
  });

  it('with every proposal dropped it discards and says there is nothing left', async () => {
    const r = await dreamWithThree();
    const a = api();
    for (const id of ['p1', 'p2', 'p3'])
      await a.handlers['dream:drop']('r1', id, true);
    await expect(a.handlers['dream:openAsTask']('r1')).rejects.toThrow(
      'Nothing left to open',
    );
    expect(await new GitClient().branchExists(repoPath, BRANCH)).toBe(false);
    expect(existsSync(path.dirname(r.worktreePath))).toBe(false);
    expect(store.repo('r1').rejections).toHaveLength(3);
    expect(store.journal()[0].closed).toMatchObject({ as: 'discarded' });
  });

  it('discard removes worktree, branch and data and remembers every proposal as rejected', async () => {
    const r = await dreamWithThree();
    await api().handlers['dream:discard']('r1');
    expect(await new GitClient().branchExists(repoPath, BRANCH)).toBe(false);
    expect(existsSync(path.dirname(r.worktreePath))).toBe(false);
    expect(git(repoPath, 'worktree', 'list')).not.toContain(DREAM_ID);
    const state = store.repo('r1');
    expect(state.result).toBeNull();
    expect(state.rejections.map((x) => x.title)).toEqual([
      'Rule 1',
      'Rule 2',
      'Rule 3',
    ]);
    expect(store.journal()[0].closed).toEqual({
      as: 'discarded',
      kept: 0,
      dropped: 3,
      taskName: null,
    });
    expect(changed()).toBe(1);
  });

  const MISMATCH = "The dream's record does not match its folder";

  it('never removes a folder outside the dreams folder', async () => {
    const r = await dreamWithThree();
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'not-a-dream-'));
    mkdirSync(path.join(elsewhere, 'wt'));
    await store.setResult('r1', {
      ...r,
      worktreePath: path.join(elsewhere, 'wt'),
      dataDir: path.join(elsewhere, 'data'),
    });
    await expect(api().handlers['dream:discard']('r1')).rejects.toThrow(
      MISMATCH,
    );
    expect(existsSync(path.join(elsewhere, 'wt'))).toBe(true);
    expect(await new GitClient().branchExists(repoPath, BRANCH)).toBe(true);
  });

  it('open as task never touches a checkout outside the dreams folder', async () => {
    const r = await dreamWithThree();
    await store.setDropped('r1', 'p2', true);
    // A record pointing at the main checkout, which has uncommitted work.
    writeFileSync(path.join(repoPath, 'README.md'), '# work in progress\n');
    const head = git(repoPath, 'rev-parse', 'HEAD').trim();
    const tip = git(repoPath, 'rev-parse', BRANCH).trim();
    const bad = { ...store.repo('r1').result!, worktreePath: repoPath };
    await store.setResult('r1', bad);
    await expect(api().handlers['dream:openAsTask']('r1')).rejects.toThrow(
      MISMATCH,
    );
    expect(git(repoPath, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(readFileSync(path.join(repoPath, 'README.md'), 'utf8')).toBe(
      '# work in progress\n',
    );
    expect(existsSync(path.join(path.dirname(repoPath), 'hooks'))).toBe(false);
    expect(git(repoPath, 'rev-parse', BRANCH).trim()).toBe(tip);
    expect(existsSync(r.worktreePath)).toBe(true);
    expect(store.repo('r1').result).not.toBeNull();
  });

  it.each([
    ['a branch of another shape', { branch: 'main' }],
    ['a branch not named after the dream', { branch: 'dream/2026-11-20-2' }],
    ['another repo id', { repoId: 'r2' }],
  ] as const)('refuses a record with %s', async (_what, over) => {
    const r = await dreamWithThree();
    await store.setResult('r1', { ...r, ...over });
    await expect(api().handlers['dream:openAsTask']('r1')).rejects.toThrow(
      MISMATCH,
    );
    await expect(api().handlers['dream:discard']('r1')).rejects.toThrow(
      MISMATCH,
    );
    expect(existsSync(r.worktreePath)).toBe(true);
    expect(git(r.worktreePath, 'branch', '--show-current').trim()).toBe(BRANCH);
  });

  describe('a half-removed dream (its wt folder left without .git) inside an enclosing repo', () => {
    let home: string;
    const homeState = () => ({
      head: git(home, 'rev-parse', 'HEAD').trim(),
      branch: git(home, 'branch', '--show-current').trim(),
      readme: readFileSync(path.join(home, 'README.md'), 'utf8'),
    });
    /** User data inside a dotfiles-like repo with uncommitted work, and the dream folder in it. */
    const halfRemoved = async (
      o: { drop?: boolean; rebuilt?: boolean } = {},
    ) => {
      home = makeRepo('home');
      git(home, 'checkout', '-q', '-b', 'dotfiles');
      writeFileSync(path.join(home, 'README.md'), '# uncommitted\n');
      deps.dreamsDir = path.join(home, 'dreams');
      const r = await dreamWithThree();
      if (o.drop) await store.setDropped('r1', 'p2', true);
      if (o.rebuilt) {
        git(r.worktreePath, 'reset', '-q', '--hard', r.baseSha);
        git(
          r.worktreePath,
          'cherry-pick',
          r.proposals[0].commit,
          r.proposals[2].commit,
        );
      }
      // What a removal stopped part way by a locked file leaves: the folder, without its .git file.
      rmSync(path.join(r.worktreePath, '.git'));
      const before = homeState();
      return { r, before };
    };

    it('discard removes the leftovers and the branch, and leaves the enclosing repo alone', async () => {
      const { r, before } = await halfRemoved();
      await api().handlers['dream:discard']('r1');
      expect(existsSync(path.dirname(r.worktreePath))).toBe(false);
      expect(await new GitClient().branchExists(repoPath, BRANCH)).toBe(false);
      expect(store.repo('r1').result).toBeNull();
      expect(homeState()).toEqual(before);
    });

    it('open as task refuses without touching anything when the branch was not rebuilt', async () => {
      const { r, before } = await halfRemoved({ drop: true });
      const tip = git(repoPath, 'rev-parse', BRANCH).trim();
      await expect(api().handlers['dream:openAsTask']('r1')).rejects.toThrow(
        /^The dream could not be opened as a task$/,
      );
      expect(git(repoPath, 'rev-parse', BRANCH).trim()).toBe(tip);
      expect(existsSync(r.worktreePath)).toBe(true);
      expect(store.repo('r1').result).not.toBeNull();
      expect(homeState()).toEqual(before);
    });

    it('open as task finishes when the branch was rebuilt already', async () => {
      const { r, before } = await halfRemoved({ drop: true, rebuilt: true });
      expect(await api().handlers['dream:openAsTask']('r1')).toEqual({
        branch: BRANCH,
      });
      expect(subjects(r.baseSha, BRANCH)).toEqual([
        'dream: Rule 1',
        'dream: Rule 3',
      ]);
      expect(existsSync(path.dirname(r.worktreePath))).toBe(false);
      expect(store.repo('r1').result).toBeNull();
      expect(homeState()).toEqual(before);
    });

    it('open as task finishes when nothing was dropped', async () => {
      const { before } = await halfRemoved();
      expect(await api().handlers['dream:openAsTask']('r1')).toEqual({
        branch: BRANCH,
      });
      expect(homeState()).toEqual(before);
    });
  });

  it('refuses when the dream worktree is not on the dream branch', async () => {
    const r = await dreamWithThree();
    git(r.worktreePath, 'checkout', '-q', '-b', 'elsewhere');
    await expect(api().handlers['dream:openAsTask']('r1')).rejects.toThrow(
      MISMATCH,
    );
    expect(git(r.worktreePath, 'branch', '--show-current').trim()).toBe(
      'elsewhere',
    );
    expect(subjects(r.baseSha, BRANCH)).toHaveLength(3);
  });

  it('says a store failure in a fixed phrase, never the error’s path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await dreamWithThree();
    vi.spyOn(store, 'reject').mockRejectedValueOnce(
      new Error(`EACCES: permission denied, open '${dir}/dreams.json'`),
    );
    await expect(api().handlers['dream:discard']('r1')).rejects.toThrow(
      /^The dream could not be saved$/,
    );
  });

  it('refuses result changes before the scheduler started (the store may not be loaded)', async () => {
    started = false;
    await expect(api().handlers['dream:discard']('r1')).rejects.toThrow(
      'Dreams are still starting',
    );
  });
});

describe('a repo that goes away', () => {
  it('removed from Shellie: stops its dream, discards its result, forgets its state and its settings', async () => {
    const r = await dreamWithThree();
    await setDreaming(ready({ enabled: true }));
    status = {
      ...status,
      running: { repoId: 'r1', startedAt: 1, step: 'reading' },
    };
    await store.setOpened('r1', {
      dreamId: '2026-11-19-1',
      branch: 'dream/2026-11-19-1',
      at: '2026-11-19T03:00:00.000Z',
      kept: 1,
      titles: ['Old'],
    });
    git(repoPath, 'branch', 'dream/2026-11-19-1');
    const events: [string, unknown][] = [];
    deps.event = (name, props) => events.push([name, props]);
    const repo = { id: 'r1', name: 'Portal', path: repoPath };
    // As Shellie has it once `repos:remove` ran.
    deps.repos = () => [];
    await api().repoRemoved(repo);
    expect(scheduler.stopDreamOf).toHaveBeenCalledWith(
      'r1',
      expect.any(Number),
    );
    expect(existsSync(path.join(deps.dreamsDir, 'r1', DREAM_ID))).toBe(false);
    expect(git(repoPath, 'branch', '--list', BRANCH).trim()).toBe('');
    expect(git(repoPath, 'worktree', 'list')).not.toContain(DREAM_ID);
    // The branch of a result opened as a task is the owner's: it stays.
    expect(
      git(repoPath, 'branch', '--list', 'dream/2026-11-19-1').trim(),
    ).not.toBe('');
    expect(store.repoIds()).toEqual([]);
    expect(store.repo('r1').opened).toBeNull();
    expect(store.journal()[0]).toMatchObject({
      dreamId: r.id,
      closed: { as: 'discarded', kept: 0, dropped: 3 },
    });
    expect(settings.get().dreaming.repos).toEqual({});
    expect(settings.get().dreaming.enabled).toBe(false);
    expect(events).toContainEqual(['dream.switched_off', { by: 'narrowed' }]);
    expect(events).toContainEqual([
      'dream.result',
      expect.objectContaining({ outcome: 'discarded' }),
    ]);
    expect(changed()).toBeGreaterThan(0);
  });

  it('removed from Shellie with another repo still ticked: dreaming stays on for it', async () => {
    await setDreaming(
      ready({
        enabled: true,
        repos: {
          r1: { on: true, folders: ['.apm'] },
          r2: { on: true, folders: ['.apm'] },
        },
      }),
    );
    deps.repos = () => [{ id: 'r2', name: 'Billing', path: repoPath }];
    await api().repoRemoved({ id: 'r1', name: 'Portal', path: repoPath });
    expect(settings.get().dreaming.enabled).toBe(true);
    expect(Object.keys(settings.get().dreaming.repos)).toEqual(['r2']);
  });

  it('a repo folder deleted on disk: Discard removes the dream folder and closes the result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await dreamWithThree();
    rmSync(repoPath, { recursive: true, force: true });
    await api().handlers['dream:discard']('r1');
    expect(existsSync(path.join(deps.dreamsDir, 'r1', DREAM_ID))).toBe(false);
    expect(store.repo('r1').result).toBeNull();
    expect(store.journal()[0]).toMatchObject({
      dreamId: r.id,
      closed: { as: 'discarded' },
    });
  });
});

describe('dream:diff and dream:file', () => {
  const BIG = 600 * 1024;

  /**
   * A dream of one proposal whose commit changes a.md, adds new.md, deletes old.md, adds a binary and a file over
   * 500 kB, on a real dream worktree.
   */
  async function dreamOfMany(): Promise<DreamResult> {
    commitFile(repoPath, 'a.md', 'one\ntwo\nthree\n');
    commitFile(repoPath, 'old.md', 'gone soon\n');
    const dreamDir = path.join(deps.dreamsDir, 'r1', DREAM_ID);
    mkdirSync(path.join(dreamDir, 'data'), { recursive: true });
    const baseSha = git(repoPath, 'rev-parse', 'HEAD').trim();
    git(
      repoPath,
      'worktree',
      'add',
      '-q',
      '-b',
      BRANCH,
      path.join(dreamDir, 'wt'),
      'main',
    );
    const wt = realpathSync(path.join(dreamDir, 'wt'));
    writeFileSync(path.join(wt, 'a.md'), 'one\n2\nthree\nfour\n');
    writeFileSync(path.join(wt, 'new.md'), 'fresh\n');
    rmSync(path.join(wt, 'old.md'));
    writeFileSync(path.join(wt, 'pic.png'), Buffer.from([0x89, 0, 1, 2, 0]));
    writeFileSync(path.join(wt, 'big.txt'), 'x\n'.repeat(BIG / 2));
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'dream: Many');
    const commit = git(wt, 'rev-parse', 'HEAD').trim();
    const result: DreamResult = {
      id: DREAM_ID,
      repoId: 'r1',
      branch: BRANCH,
      baseSha,
      worktreePath: wt,
      dataDir: realpathSync(path.join(dreamDir, 'data')),
      at: '2026-11-20T03:00:00.000Z',
      model: MODEL,
      tokens: 100,
      sessions: 2,
      proposals: [
        {
          id: 'p1',
          kind: 'changed-rule',
          title: 'Many',
          why: 'Why',
          evidence: [],
          files: ['a.md'],
          commit,
          dropped: false,
        },
      ],
      reverted: [],
      removedByCheck: 0,
    };
    await store.setResult('r1', result);
    return result;
  }

  const byPath = async () =>
    Object.fromEntries(
      (await api().handlers['dream:diff']('r1', 'p1')).map((f) => [f.path, f]),
    );

  /** Another commit on the dream branch, made by `write` in the worktree, as proposal p1's. */
  async function recommit(r: DreamResult, write: (wt: string) => void) {
    write(r.worktreePath);
    git(r.worktreePath, 'add', '-A');
    git(r.worktreePath, 'commit', '-q', '-m', 'dream: More');
    const commit = git(r.worktreePath, 'rev-parse', 'HEAD').trim();
    await store.setResult('r1', {
      ...r,
      proposals: [{ ...r.proposals[0], commit }],
    });
  }

  const lines = (f: DreamFileDiff) =>
    f.hunks.flatMap((h) => h.lines.map((l) => `${l.kind}:${l.text}`));

  it('returns each file with the hunks git computes and counts from the same patch', async () => {
    await dreamOfMany();
    const files = await byPath();
    expect(Object.keys(files).sort()).toEqual([
      'a.md',
      'big.txt',
      'new.md',
      'old.md',
      'pic.png',
    ]);
    expect(files['a.md']).toMatchObject({ added: 2, removed: 1 });
    expect(files['a.md'].hunks).toEqual([
      {
        header: '@@ -1,3 +1,4 @@',
        lines: [
          { kind: 'context', text: 'one', oldNo: 1, newNo: 1 },
          { kind: 'del', text: 'two', oldNo: 2, newNo: null },
          { kind: 'add', text: '2', oldNo: null, newNo: 2 },
          { kind: 'context', text: 'three', oldNo: 3, newNo: 3 },
          { kind: 'add', text: 'four', oldNo: null, newNo: 4 },
        ],
      },
    ]);
    expect(files['new.md']).toMatchObject({ added: 1, removed: 0 });
    expect(lines(files['new.md'])).toEqual(['add:fresh']);
    expect(files['old.md']).toMatchObject({ added: 0, removed: 1 });
    expect(lines(files['old.md'])).toEqual(['del:gone soon']);
    expect(files['a.md']).not.toHaveProperty('before');
  });

  it('gives a binary file and a file over 500 kB no lines, but says so and counts what git counts', async () => {
    await dreamOfMany();
    const files = await byPath();
    expect(files['pic.png']).toEqual({
      path: 'pic.png',
      added: 0,
      removed: 0,
      hunks: [],
      binary: true,
    });
    expect(files['big.txt']).toEqual({
      path: 'big.txt',
      added: BIG / 2,
      removed: 0,
      hunks: [],
      tooLarge: true,
    });
  });

  it('keeps a change of the trailing newline, with git’s note', async () => {
    const r = await dreamOfMany();
    await recommit(r, (wt) =>
      writeFileSync(path.join(wt, 'a.md'), 'one\n2\nthree\nfour'),
    );
    const f = (await byPath())['a.md'];
    expect(f).toMatchObject({ added: 1, removed: 1 });
    expect(lines(f)).toEqual([
      'context:one',
      'context:2',
      'context:three',
      'del:four',
      'add:four',
      'note:No newline at end of file',
    ]);
    expect(f.hunks[0].lines.at(-1)).toEqual({
      kind: 'note',
      text: 'No newline at end of file',
      oldNo: null,
      newNo: null,
    });
  });

  it('shows two far apart edits of a long file as two small hunks', async () => {
    const r = await dreamOfMany();
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    await recommit(r, (wt) =>
      writeFileSync(path.join(wt, 'long.md'), `${long.join('\n')}\n`),
    );
    git(r.worktreePath, 'rev-parse', 'HEAD');
    const before = store.repo('r1').result!;
    await recommit(before, (wt) => {
      const next = [...long];
      next[0] = 'first';
      next[1999] = 'last';
      writeFileSync(path.join(wt, 'long.md'), `${next.join('\n')}\n`);
    });
    const f = (await byPath())['long.md'];
    expect(f).toMatchObject({ added: 2, removed: 2 });
    expect(f.hunks).toHaveLength(2);
    const shown = f.hunks.flatMap((h) => h.lines);
    expect(shown.filter((l) => l.kind === 'add')).toHaveLength(2);
    expect(shown.filter((l) => l.kind === 'del')).toHaveLength(2);
  });

  it('cuts a file at 400 lines and a line at 2 000 characters', async () => {
    const r = await dreamOfMany();
    await recommit(r, (wt) => {
      writeFileSync(
        path.join(wt, 'many.md'),
        Array.from({ length: 500 }, (_, i) => `${i}\n`).join(''),
      );
      writeFileSync(path.join(wt, 'wide.md'), `${'w'.repeat(3000)}\n`);
    });
    const files = await byPath();
    expect(files['many.md']).toMatchObject({ added: 500, truncated: true });
    expect(files['many.md'].hunks.flatMap((h) => h.lines)).toHaveLength(400);
    expect(files['wide.md'].truncated).toBeUndefined();
    expect(files['wide.md'].hunks[0].lines[0].text).toHaveLength(2000);
  });

  it('keeps the whole answer under 2 MB: later files come back without lines', async () => {
    const r = await dreamOfMany();
    const line = `${'z'.repeat(1199)}\n`;
    await recommit(r, (wt) => {
      for (let i = 0; i < 6; i++)
        writeFileSync(path.join(wt, `heavy${i}.md`), `${i}${line}`.repeat(400));
    });
    const files = await api().handlers['dream:diff']('r1', 'p1');
    expect(JSON.stringify(files).length).toBeLessThanOrEqual(2 * 1024 * 1024);
    const heavy = files.filter((f) => f.path.startsWith('heavy'));
    expect(heavy.some((f) => f.tooLarge && f.hunks.length === 0)).toBe(true);
    expect(heavy.find((f) => f.tooLarge)!.added).toBe(400);
  });

  it('reads from the repo when the dream worktree folder is gone', async () => {
    const r = await dreamOfMany();
    git(repoPath, 'worktree', 'remove', '--force', r.worktreePath);
    expect(existsSync(r.worktreePath)).toBe(false);
    expect(lines((await byPath())['new.md'])).toEqual(['add:fresh']);
    expect(await api().handlers['dream:file']('r1', 'p1', 'a.md')).toEqual({
      before: 'one\ntwo\nthree\n',
      after: 'one\n2\nthree\nfour\n',
    });
  });

  it('shows at most 50 files of a proposal', async () => {
    const r = await dreamOfMany();
    await recommit(r, (wt) => {
      for (let i = 0; i < 60; i++)
        writeFileSync(path.join(wt, `f${i}.md`), `${i}\n`);
    });
    expect(await api().handlers['dream:diff']('r1', 'p1')).toHaveLength(50);
  });

  it('dream:file gives one file’s two texts, or says it is binary or too large', async () => {
    await dreamOfMany();
    const h = api().handlers;
    expect(await h['dream:file']('r1', 'p1', 'new.md')).toEqual({
      before: '',
      after: 'fresh\n',
    });
    expect(await h['dream:file']('r1', 'p1', 'old.md')).toEqual({
      before: 'gone soon\n',
      after: '',
    });
    expect(await h['dream:file']('r1', 'p1', 'pic.png')).toEqual({
      binary: true,
    });
    expect(await h['dream:file']('r1', 'p1', 'big.txt')).toEqual({
      tooLarge: true,
    });
  });

  it.each([
    ['a file the commit does not change', 'README.md'],
    ['a path with ..', 'x/../a.md'],
    ['a path of another case', 'A.md'],
    ['an absolute path', '/etc/passwd'],
  ])('dream:file refuses %s', async (_what, file) => {
    await dreamOfMany();
    await expect(
      api().handlers['dream:file']('r1', 'p1', file),
    ).rejects.toThrow(/^This proposal does not change that file$/);
  });

  it('refuses an unknown proposal or repo in a fixed phrase', async () => {
    await dreamOfMany();
    const h = api().handlers;
    await expect(h['dream:diff']('r1', 'p9')).rejects.toThrow(
      /^This dream has no such proposal$/,
    );
    await expect(h['dream:diff']('r9', 'p1')).rejects.toThrow(
      /^This repo has no dream to review$/,
    );
    await expect(h['dream:file']('r1', 'p9', 'a.md')).rejects.toThrow(
      /^This dream has no such proposal$/,
    );
  });

  it('reads nothing for a stored result that fails the check', async () => {
    const r = await dreamOfMany();
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'not-a-dream-'));
    await store.setResult('r1', {
      ...r,
      worktreePath: path.join(elsewhere, 'wt'),
      dataDir: path.join(elsewhere, 'data'),
    });
    const run = vi.spyOn(deps.git as GitClient, 'run');
    await expect(api().handlers['dream:diff']('r1', 'p1')).rejects.toThrow(
      MISMATCH_PHRASE,
    );
    await expect(
      api().handlers['dream:file']('r1', 'p1', 'a.md'),
    ).rejects.toThrow(MISMATCH_PHRASE);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a commit that is not a full sha, without running git with it', async () => {
    const r = await dreamOfMany();
    await store.setResult('r1', {
      ...r,
      proposals: [{ ...r.proposals[0], commit: '--output=/tmp/x' }],
    });
    const run = vi.spyOn(deps.git as GitClient, 'run');
    await expect(api().handlers['dream:diff']('r1', 'p1')).rejects.toThrow(
      MISMATCH_PHRASE,
    );
    expect(
      run.mock.calls.some(([, args]) => args.includes('--output=/tmp/x')),
    ).toBe(false);
  });

  it('gives every git call a 15 s timeout, and a hung call the fixed phrase', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await dreamOfMany();
    const g = deps.git as GitClient;
    const run = vi.spyOn(g, 'run');
    await api().handlers['dream:diff']('r1', 'p1');
    await api().handlers['dream:file']('r1', 'p1', 'a.md');
    expect(run.mock.calls.length).toBeGreaterThan(0);
    for (const [, , opts] of run.mock.calls)
      expect(opts?.timeoutMs).toBe(15_000);
    run.mockImplementation(async (_cwd, args) => {
      if (args.includes('diff-tree'))
        throw new Error('git timed out after 15000 ms');
      return '';
    });
    await expect(api().handlers['dream:diff']('r1', 'p1')).rejects.toThrow(
      /^The changes could not be read$/,
    );
  });

  it('says a git failure in a fixed phrase, never a path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await dreamOfMany();
    await store.setResult('r1', {
      ...r,
      proposals: [{ ...r.proposals[0], commit: 'f'.repeat(40) }],
    });
    await expect(api().handlers['dream:diff']('r1', 'p1')).rejects.toThrow(
      /^The changes could not be read$/,
    );
    await expect(
      api().handlers['dream:file']('r1', 'p1', 'a.md'),
    ).rejects.toThrow(/^The changes could not be read$/);
  });
});

describe('telemetry', () => {
  /** Only enums, counts and booleans: no model, repo, branch, path or text. */
  const ENUMS = new Set([
    'tokens',
    'eur',
    'none',
    'owner',
    'wrong-model',
    'narrowed',
    'task',
    'discarded',
  ]);
  const events = () =>
    vi.mocked(deps.event!).mock.calls as [string, Record<string, unknown>][];
  const safe = (props: Record<string, unknown>) => {
    for (const v of Object.values(props))
      if (typeof v === 'string') expect(ENUMS.has(v)).toBe(true);
      else expect(['number', 'boolean']).toContain(typeof v);
    expect(JSON.stringify(props)).not.toMatch(
      /Portal|zai|glm|dream\/|\.apm|r1/,
    );
  };

  beforeEach(() => {
    deps.event = vi.fn();
  });

  it('dream.enabled carries the limit kind and the repo count when switched on', async () => {
    await setDreaming(ready());
    await api().handlers['dream:switchOn'](true);
    expect(events()).toEqual([
      ['dream.enabled', { limit: 'tokens', repos: 1 }],
    ]);
    safe(events()[0][1]);
  });

  it('dream.switched_off says the owner switched off, or a narrowing did; nothing when it was off', async () => {
    await setDreaming(ready({ enabled: true }));
    await api().handlers['dream:switchOff']();
    await api().handlers['dream:switchOff']();
    await setDreaming(ready({ enabled: true }));
    await api().handlers['dream:save'](
      {
        ...ready({ enabled: true }),
        repos: { r1: { on: false, folders: ['.apm'] } },
      },
      false,
    );
    expect(events()).toEqual([
      ['dream.switched_off', { by: 'owner' }],
      ['dream.switched_off', { by: 'narrowed' }],
    ]);
    events().forEach(([, p]) => safe(p));
  });

  it('dream.test carries whether the test passed, never the model or the message', async () => {
    await setDreaming(ready({ testedModel: null }));
    await api().handlers['dream:test'](MODEL);
    answered = [OTHER];
    await api().handlers['dream:test'](MODEL);
    expect(events()).toEqual([
      ['dream.test', { ok: true }],
      ['dream.test', { ok: false }],
    ]);
  });

  it('dream.result carries kept, dropped and how the result was closed', async () => {
    await dreamWithThree();
    const a = api();
    await a.handlers['dream:drop']('r1', 'p2', true);
    await a.handlers['dream:openAsTask']('r1');
    expect(events()).toEqual([
      ['dream.result', { kept: 2, dropped: 1, outcome: 'task' }],
    ]);
    safe(events()[0][1]);
  });

  it('dream.result says discarded for Discard dream', async () => {
    await dreamWithThree();
    await api().handlers['dream:discard']('r1');
    expect(events()).toEqual([
      ['dream.result', { kept: 0, dropped: 3, outcome: 'discarded' }],
    ]);
  });
});
