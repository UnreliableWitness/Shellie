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
import {
  dreamingOf,
  type DreamFileDiff,
  type DreamingSettings,
  type DreamJournalEntry,
  type DreamProposal,
  type DreamResult,
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
  dreamRefusal,
  DREAM_TEST_PROMPT,
  DREAM_TEST_TIMEOUT_MS,
  type DreamHandlerDeps,
} from './dreamHandlers';
import { DreamStore } from './DreamStore';
import { opencodeModelList } from './models';
import { dreamArgs } from './opencodeDream';
import type { DreamStatus } from './scheduler';
import { ASK_LEFT_BY_QUIT } from './startDreams';

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

/** The project the tests are about; `p2` exists beside it. */
const P = 'p1';
const block = (project = P): DreamingSettings =>
  dreamingOf(settings.get().dreaming, project);
const setDreaming = (d: DreamingSettings, project = P) =>
  settings.updateDreamingOf(project, () => d);

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
    runningDream: vi.fn(() => null),
    status: vi.fn(() => status),
    switchOn: vi.fn(async (project: string, save: () => Promise<void>) => {
      await save();
      await store.setSwitchedOff(project, null);
    }),
    switchOffModel: vi.fn(async () => undefined),
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
    repos: () => [
      { id: 'r1', name: 'Portal', path: repoPath, connectionId: P },
    ],
    projects: () => [P, 'p2'],
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
    const view = await api().handlers['dream:get'](P);
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
      settings: block(),
    });
  });

  it('never starts a process: with dreaming off and no OpenCode installed, four in a row spawn nothing', async () => {
    askModels.mockResolvedValue(null);
    const h = api().handlers;
    for (let i = 0; i < 4; i++)
      expect((await h['dream:get'](P)).models).toBeNull();
    expect(askModels).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('answers before the scheduler started: dreaming as stored, no wait, no sessions known', async () => {
    started = false;
    const view = await api().handlers['dream:get'](P);
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
    await expect(api().handlers['dream:switchOn'](P, true)).rejects.toThrow(
      `Dreaming cannot be switched on yet: ${reason}`,
    );
    expect(block().enabled).toBe(false);
    expect(changed()).toBe(0);
  });

  it('switches on with all four and the tick, through the scheduler, clearing a switch-off', async () => {
    await setDreaming(ready());
    await store.setSwitchedOff(P, {
      answered: 'a/b',
      chosen: MODEL,
      repoId: 'r1',
    });
    const saved = await api().handlers['dream:switchOn'](P, true);
    expect(saved.enabled).toBe(true);
    expect(block().enabled).toBe(true);
    expect(scheduler.switchOn).toHaveBeenCalledOnce();
    expect(store.switchedOff(P)).toBeNull();
    expect(changed()).toBe(1);
  });

  it('never switches on without the tick', async () => {
    await setDreaming(ready());
    await expect(api().handlers['dream:switchOn'](P, false)).rejects.toThrow(
      'Tick the box first',
    );
    await setDreaming(ready({ model: null }));
    await expect(api().handlers['dream:switchOn'](P, false)).rejects.toThrow();
    expect(block().enabled).toBe(false);
    expect(scheduler.switchOn).not.toHaveBeenCalled();
  });

  it('refuses before the scheduler started', async () => {
    await setDreaming(ready());
    started = false;
    await expect(api().handlers['dream:switchOn'](P, true)).rejects.toThrow(
      'Dreams are still starting',
    );
    expect(block().enabled).toBe(false);
  });

  it('switchOff saves off and stops a running dream', async () => {
    await setDreaming(ready({ enabled: true }));
    expect((await api().handlers['dream:switchOff'](P)).enabled).toBe(false);
    expect(block().enabled).toBe(false);
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
    expect((await api().handlers['dream:save'](P, next, false)).limit).toEqual(
      next.limit,
    );
    expect(block().enabled).toBe(true);
    expect(changed()).toBe(1);
  });

  it('refuses a widening change while on without the tick, and applies it with the tick', async () => {
    await setDreaming(ready({ enabled: true }));
    const next = wider(ready({ enabled: true }));
    await expect(api().handlers['dream:save'](P, next, false)).rejects.toThrow(
      'Confirm the change first',
    );
    expect(block().repos.r1.folders).toEqual(['.apm']);
    await api().handlers['dream:save'](P, next, true);
    expect(block().repos.r1.folders).toEqual(['.apm', 'AGENTS.md']);
  });

  it('a narrowing change that leaves nothing to dream switches dreaming off in the same write', async () => {
    await setDreaming(ready({ enabled: true }));
    const saved = await api().handlers['dream:save'](
      P,
      {
        ...ready({ enabled: true }),
        repos: { r1: { on: false, folders: ['.apm'] } },
      },
      false,
    );
    expect(saved.enabled).toBe(false);
    expect(block().enabled).toBe(false);
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
      { id: 'r1', name: 'Portal', path: repoPath, connectionId: P },
      { id: 'r2', name: 'Billing', path: repoPath, connectionId: P },
    ];
    status = {
      ...status,
      running: { repoId: 'r1', project: P, startedAt: 1, step: 'reading' },
    };
    const h = api().handlers;
    await h['dream:save'](
      P,
      { ...block(), limit: { kind: 'tokens', perDay: 10 } },
      false,
    );
    expect(scheduler.stopDream).not.toHaveBeenCalled();
    const saved = await h['dream:save'](
      P,
      {
        ...block(),
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
      P,
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
    await expect(api().handlers['dream:switchOff'](P)).rejects.toThrow(
      /^The dream settings could not be saved$/,
    );
  });

  it('applies a widening change while off without the tick', async () => {
    await setDreaming(ready());
    await api().handlers['dream:save'](P, wider(ready()), false);
    expect(block().repos.r1.folders).toEqual(['.apm', 'AGENTS.md']);
  });

  it('never takes enabled, model or testedModel, and drops repos Shellie does not know', async () => {
    await setDreaming(ready());
    const saved = await api().handlers['dream:save'](
      P,
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
    expect(block()).toEqual(saved);
  });

  it.each(['.', '/etc', 'a/../b', '.opencode/agent'])(
    'refuses %s as a folder',
    async (folder) => {
      await setDreaming(ready());
      await expect(
        api().handlers['dream:save'](
          P,
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
    let under = '';
    run.mockImplementation(async (_cmd, o: { cwd: string }) => {
      inFolder = readdirSync(o.cwd);
      // Both resolved while the folder exists: Windows temp paths come in a short and a long spelling.
      under = path.relative(
        realpathSync.native(deps.dreamsDir),
        realpathSync.native(o.cwd),
      );
      return `${JSON.stringify({ sessionID: 'ses_1' })}\n`;
    });
    expect(await api().handlers['dream:test'](P, MODEL)).toEqual({ ok: true });
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
      deps.platform.opencodeCommand(undefined, dreamArgs(MODEL, 'test', P))
        .args,
    );
    expect(o.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(JSON.parse(o.env.OPENCODE_CONFIG_CONTENT).small_model).toBe(MODEL);
    expect(o.input).toBe(DREAM_TEST_PROMPT);
    expect(o.timeoutMs).toBe(DREAM_TEST_TIMEOUT_MS);
    expect(deps.sessionModels).toHaveBeenCalledWith('ses_1');
    // Under the dreams folder, so the ledger knows its usage as a dream's and never sends it.
    expect(under).toMatch(/^\.test-[^/\\]+[/\\]wt$/);
    expect(existsSync(path.dirname(cwdHeld!))).toBe(false);
    expect(block()).toMatchObject({
      model: MODEL,
      testedModel: MODEL,
    });
    expect(changed()).toBe(1);
  });

  it('a re-test of the saved model that another model answered hands the switch-off to the scheduler, as a wrong-model dream does', async () => {
    await setDreaming(ready({ enabled: true }));
    answered = [MODEL, 'anthropic/claude-x'];
    expect(await api().handlers['dream:test'](P, MODEL)).toEqual({
      ok: false,
      message: 'Another model answered',
    });
    expect(scheduler.switchOffModel).toHaveBeenCalledExactlyOnceWith({
      project: P,
      model: MODEL,
      answered: 'anthropic/claude-x',
      repoId: '',
    });
    expect(changed()).toBe(1);
  });

  it('before the scheduler started, another model answering a re-test still saves dreaming off, without a record', async () => {
    await setDreaming(ready({ enabled: true }));
    started = false;
    const events: [string, unknown][] = [];
    deps.event = (name, props) => events.push([name, props]);
    answered = [MODEL, 'anthropic/claude-x'];
    expect((await api().handlers['dream:test'](P, MODEL)).ok).toBe(false);
    expect(block()).toMatchObject({ enabled: false, testedModel: null });
    expect(store.switchedOff(P)).toBeNull();
    expect(events).toContainEqual([
      'dream.switched_off',
      { by: 'wrong-model' },
    ]);
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
      expect((await api().handlers['dream:test'](P, MODEL)).ok).toBe(false);
      expect(block()).toMatchObject({
        enabled: false,
        testedModel: null,
      });
      expect(store.switchedOff(P)).toBeNull();
      expect(scheduler.switchOffModel).not.toHaveBeenCalled();
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
    expect(await api().handlers['dream:test'](P, OTHER)).toMatchObject({
      ok: false,
    });
    expect(block()).toMatchObject({
      enabled: true,
      model: MODEL,
      testedModel: MODEL,
    });
    expect(store.switchedOff(P)).toBeNull();
    expect(scheduler.stopDream).not.toHaveBeenCalled();
    expect(changed()).toBe(0);
  });

  it('a passed test of a new model switches dreaming off and stops a dream still running on the old one', async () => {
    await setDreaming(ready({ enabled: true }));
    answered = [OTHER];
    expect(await api().handlers['dream:test'](P, OTHER)).toEqual({ ok: true });
    expect(block().enabled).toBe(false);
    expect(scheduler.stopDream).toHaveBeenCalled();
  });

  it('testing a new model while on switches dreaming off', async () => {
    await setDreaming(ready({ enabled: true }));
    expect(await api().handlers['dream:test'](P, OTHER)).toEqual({
      ok: false,
      message: 'Another model answered',
    });
    answered = [OTHER];
    expect(await api().handlers['dream:test'](P, OTHER)).toEqual({ ok: true });
    expect(block()).toMatchObject({
      enabled: false,
      model: OTHER,
      testedModel: OTHER,
    });
  });

  it('testing the same model again while on keeps dreaming on', async () => {
    await setDreaming(ready({ enabled: true }));
    expect(await api().handlers['dream:test'](P, MODEL)).toEqual({ ok: true });
    expect(block().enabled).toBe(true);
  });

  it('refuses a model not in OpenCode’s list before any call', async () => {
    expect(await api().handlers['dream:test'](P, 'zai/unknown')).toEqual({
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
    expect(await h['dream:test'](P, MODEL)).toEqual({
      ok: false,
      message: 'OpenCode was not found',
    });
    run.mockRejectedValueOnce(new Error('opencode timed out after 120 s'));
    expect(await h['dream:test'](P, MODEL)).toEqual({
      ok: false,
      message: 'The test timed out',
    });
    run.mockRejectedValueOnce(
      new ExitError('secret session text', 1, 'secret'),
    );
    expect(await h['dream:test'](P, MODEL)).toEqual({
      ok: false,
      message: `${MODEL} did not answer`,
    });
    run.mockResolvedValueOnce('no events at all');
    expect(await h['dream:test'](P, MODEL)).toEqual({
      ok: false,
      message: `${MODEL} did not answer`,
    });
  });

  it('says a test folder that cannot be made in a fixed phrase', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(path.join(dir, 'not-a-folder'), '');
    deps.dreamsDir = path.join(dir, 'not-a-folder', 'dreams');
    expect(await api().handlers['dream:test'](P, MODEL)).toEqual({
      ok: false,
      message: 'The test could not be run',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs one test at a time', async () => {
    let finish!: (s: string) => void;
    run.mockImplementationOnce(() => new Promise<string>((r) => (finish = r)));
    const h = api().handlers;
    const first = h['dream:test'](P, MODEL);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    expect(await h['dream:test'](P, MODEL)).toEqual({
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
    await api().handlers['dream:stop'](P);
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

describe('dream:folderExists', () => {
  it('checks the exact spelling in the repo’s HEAD tree, a folder or a file, literally', async () => {
    mkdirSync(path.join(repoPath, '.apm', 'rules'), { recursive: true });
    mkdirSync(path.join(repoPath, 'odd'));
    commitFile(repoPath, '.apm/rules/a.md', 'a\n', 'apm');
    commitFile(repoPath, 'AGENTS.md', 'x\n', 'agents');
    // A name that is also a pattern; brackets, since Windows allows no star in a name.
    commitFile(repoPath, 'odd/[x].md', 'x\n', 'pattern');
    const h = api().handlers;
    expect(await h['dream:folderExists']('r1', '.apm')).toBe(true);
    expect(await h['dream:folderExists']('r1', '.apm/rules')).toBe(true);
    expect(await h['dream:folderExists']('r1', 'AGENTS.md')).toBe(true);
    expect(await h['dream:folderExists']('r1', '.APM')).toBe(false);
    expect(await h['dream:folderExists']('r1', 'agents.md')).toBe(false);
    expect(await h['dream:folderExists']('r1', 'odd/[x].md')).toBe(true);
    expect(await h['dream:folderExists']('r1', '[A]GENTS.md')).toBe(false);
    // After `--`: never an option.
    expect(await h['dream:folderExists']('r1', '--help')).toBe(false);
    // Not on disk only: a file in the work tree that HEAD lacks does not count.
    writeFileSync(path.join(repoPath, 'loose.md'), 'x');
    expect(await h['dream:folderExists']('r1', 'loose.md')).toBe(false);
  });

  it('refuses a folder the settings refuse, and an unknown repo, before any git', async () => {
    const g = deps.git as GitClient;
    const spy = vi.spyOn(g, 'run');
    const h = api().handlers;
    for (const f of ['../x', '/etc', '.opencode', 'a//b'])
      await expect(h['dream:folderExists']('r1', f)).rejects.toThrow(
        'This is not a folder a dream may change',
      );
    await expect(h['dream:folderExists']('r9', '.apm')).rejects.toThrow(
      'Unknown repo',
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('a repo that goes away', () => {
  it('removed from Shellie: stops its dream, discards its result, forgets its state and its settings', async () => {
    const r = await dreamWithThree();
    await setDreaming(ready({ enabled: true }));
    status = {
      ...status,
      running: { repoId: 'r1', project: P, startedAt: 1, step: 'reading' },
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
    const repo = { id: 'r1', name: 'Portal', path: repoPath, connectionId: P };
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
    expect(block().repos).toEqual({});
    expect(block().enabled).toBe(false);
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
    deps.repos = () => [
      { id: 'r2', name: 'Billing', path: repoPath, connectionId: P },
    ];
    await api().repoRemoved({
      id: 'r1',
      name: 'Portal',
      path: repoPath,
      connectionId: P,
    });
    expect(block().enabled).toBe(true);
    expect(Object.keys(block().repos)).toEqual(['r2']);
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
    await api().handlers['dream:switchOn'](P, true);
    expect(events()).toEqual([
      ['dream.enabled', { limit: 'tokens', repos: 1 }],
    ]);
    safe(events()[0][1]);
  });

  it('dream.switched_off says the owner switched off, or a narrowing did; nothing when it was off', async () => {
    await setDreaming(ready({ enabled: true }));
    await api().handlers['dream:switchOff'](P);
    await api().handlers['dream:switchOff'](P);
    await setDreaming(ready({ enabled: true }));
    await api().handlers['dream:save'](
      P,
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
    await api().handlers['dream:test'](P, MODEL);
    answered = [OTHER];
    await api().handlers['dream:test'](P, MODEL);
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

describe('dreams of several projects', () => {
  const Q = 'p2';
  const repoQ = () => ({
    id: 'r2',
    name: 'Api',
    path: repoPath,
    connectionId: Q as string | null,
  });
  const loose = () => ({
    id: 'loose',
    name: 'Loose',
    path: repoPath,
    connectionId: null,
  });
  const withRepos = (...more: ReturnType<typeof repoQ>[]) => {
    deps.repos = () => [
      { id: 'r1', name: 'Portal', path: repoPath, connectionId: P },
      ...more,
    ];
  };
  const forQ = (over: Partial<DreamingSettings> = {}) =>
    ready({ repos: { r2: { on: true, folders: ['.apm'] } }, ...over });

  it('dream:get shows the project’s own setup, repos and journal lines only', async () => {
    withRepos(repoQ());
    await setDreaming(ready());
    await setDreaming(forQ({ idleMinutes: 30 }), Q);
    await store.log(entry('d1', '2026-11-20T03:00:00.000Z'));
    await store.log({
      ...entry('d2', '2026-11-20T04:00:00.000Z'),
      repoId: 'r2',
    });
    const mine = await api().handlers['dream:get'](P);
    expect(mine.settings).toEqual(ready());
    expect(mine.repos.map((r) => r.id)).toEqual(['r1']);
    expect(mine.journal.map((e) => e.dreamId)).toEqual(['d1']);
    const theirs = await api().handlers['dream:get'](Q);
    expect(theirs.settings.idleMinutes).toBe(30);
    expect(theirs.repos.map((r) => r.id)).toEqual(['r2']);
    expect(theirs.journal.map((e) => e.dreamId)).toEqual(['d2']);
    expect(scheduler.status).toHaveBeenLastCalledWith(Q);
  });

  it('dream:get refuses a project that does not exist', async () => {
    await expect(api().handlers['dream:get']('nope')).rejects.toThrow(
      'This project is not known',
    );
    await expect(api().handlers['dream:switchOff']('nope')).rejects.toThrow();
    expect(settings.get().dreaming.projects).toEqual({});
  });

  it('a repo without a project shows in every project only while it has something to review', async () => {
    withRepos(loose());
    expect(
      (await api().handlers['dream:get'](P)).repos.map((r) => r.id),
    ).toEqual(['r1']);
    await store.setOpened('loose', {
      dreamId: DREAM_ID,
      branch: BRANCH,
      at: '2026-11-20T03:00:00.000Z',
      kept: 1,
      titles: ['Rule 1'],
    });
    for (const project of [P, Q]) {
      const view = await api().handlers['dream:get'](project);
      expect(view.repos.find((r) => r.id === 'loose')).toMatchObject({
        orphan: true,
      });
    }
  });

  it('dream:save refuses a repo of another project or of none, and changes nothing', async () => {
    withRepos(repoQ(), loose());
    await setDreaming(ready());
    for (const id of ['r2', 'loose'])
      await expect(
        api().handlers['dream:save'](
          P,
          ready({
            repos: {
              r1: { on: true, folders: ['.apm'] },
              [id]: { on: true, folders: ['.apm'] },
            },
          }),
          true,
        ),
      ).rejects.toThrow('A repo of another project cannot dream here');
    expect(block()).toEqual(ready());
    expect(settings.get().dreaming.projects[Q]).toBeUndefined();
  });

  it('switching one project on or off leaves the other as it is', async () => {
    withRepos(repoQ());
    await setDreaming(ready());
    await setDreaming(forQ(), Q);
    await api().handlers['dream:switchOn'](Q, true);
    expect(scheduler.switchOn).toHaveBeenCalledWith(Q, expect.any(Function));
    expect(block(Q).enabled).toBe(true);
    expect(block().enabled).toBe(false);
    await api().handlers['dream:switchOn'](P, true);
    await api().handlers['dream:switchOff'](Q);
    expect(scheduler.stopDream).toHaveBeenLastCalledWith(Q);
    expect(block(Q).enabled).toBe(false);
    expect(block().enabled).toBe(true);
  });

  it('dream:test tests for its project: the title carries it and only its block gets the model', async () => {
    answered = [OTHER];
    await api().handlers['dream:test'](Q, OTHER);
    expect(
      (run.mock.calls[0][0] as { args: string[] }).args.join(' '),
    ).toContain(`Shellie dream ${Q}: test`);
    expect(block(Q)).toMatchObject({ model: OTHER, testedModel: OTHER });
    expect(settings.get().dreaming.projects[P]).toBeUndefined();
  });

  it('before the scheduler started, another model answering a re-test switches off every project on that model, and no other', async () => {
    started = false;
    withRepos(repoQ(), { ...repoQ(), id: 'r3', connectionId: 'p3' });
    deps.projects = () => [P, Q, 'p3'];
    await setDreaming(ready({ enabled: true }));
    await setDreaming(forQ({ enabled: true }), Q);
    await setDreaming(
      ready({
        enabled: true,
        model: OTHER,
        testedModel: OTHER,
        repos: { r3: { on: true, folders: ['.apm'] } },
      }),
      'p3',
    );
    answered = ['x/y'];
    expect(await api().handlers['dream:test'](P, MODEL)).toEqual({
      ok: false,
      message: 'Another model answered',
    });
    for (const project of [P, Q]) {
      expect(block(project)).toMatchObject({
        enabled: false,
        testedModel: null,
      });
      // The dream store is not loaded yet: no record.
      expect(store.switchedOff(project)).toBeNull();
    }
    expect(block('p3')).toMatchObject({ enabled: true, testedModel: OTHER });
  });

  it('a repo moved to another project leaves its old block; a block left with nothing is off and its dream stops', async () => {
    await setDreaming(ready({ enabled: true }));
    // The scheduler's own record of the dream: its project is the one it started for.
    scheduler.runningDream.mockReturnValue({ repoId: 'r1', project: P });
    // As the real status: the repo is no longer P's, so P's view names no running dream.
    status = { ...status, running: null };
    deps.repos = () => [
      { id: 'r1', name: 'Portal', path: repoPath, connectionId: Q },
    ];
    await api().projectsChanged();
    expect(block()).toMatchObject({ enabled: false, repos: {} });
    expect(scheduler.stopDream).toHaveBeenCalledWith(P);
    // Off in the new project until it is set up there.
    expect(settings.get().dreaming.projects[Q]).toBeUndefined();
  });

  it('a removed project loses its setup and its switch-off notice', async () => {
    withRepos(repoQ());
    await setDreaming(ready({ enabled: true }));
    await setDreaming(forQ({ enabled: true }), Q);
    await store.setSwitchedOff(Q, {
      answered: 'x/y',
      chosen: MODEL,
      repoId: 'r2',
    });
    deps.projects = () => [P];
    deps.repos = () => [
      { id: 'r1', name: 'Portal', path: repoPath, connectionId: P },
      { ...repoQ(), connectionId: null },
    ];
    await api().projectsChanged();
    expect(Object.keys(settings.get().dreaming.projects)).toEqual([P]);
    expect(block().enabled).toBe(true);
    expect(store.switchedOffProjects()).toEqual([]);
  });

  it('dream:stop stops the named project’s dream only', async () => {
    await api().handlers['dream:stop'](Q);
    expect(scheduler.stopDream).toHaveBeenCalledWith(Q);
  });
});

describe('before the old setup is split over the projects', () => {
  it('refuses to write a project\u2019s setup, so the copy of the old one is not lost', async () => {
    await settings.updateDreaming(() => ({
      projects: {},
      legacy: ready({ enabled: true }),
    }));
    await expect(api().handlers['dream:switchOff'](P)).rejects.toThrow(
      'Dreams are still starting',
    );
    await expect(
      api().handlers['dream:save'](P, ready(), true),
    ).rejects.toThrow('Dreams are still starting');
    expect(settings.get().dreaming).toEqual({
      projects: {},
      legacy: ready({ enabled: true }),
    });
  });
});

describe('sending a dream (Create pull request)', () => {
  const pr = { id: 7, url: 'https://example.invalid/pullrequest/7' };
  const subjects = (from: string, to: string) =>
    git(repoPath, 'log', '--format=%s', '--reverse', `${from}..${to}`)
      .trim()
      .split('\n');

  it('hands the branch with the kept proposals to send, then closes the dream and names the pull request', async () => {
    const r = await dreamWithThree();
    const a = api();
    await a.handlers['dream:drop']('r1', 'p2', true);
    vi.mocked(deps.broadcast).mockClear();
    const seen: { subjects: string[]; worktree: boolean }[] = [];
    const out = await a.publish('r1', async (ready) => {
      // As the push sees it: the branch is the base plus the kept commits, in the dream's own worktree.
      seen.push({
        subjects: subjects(ready.baseSha, ready.branch),
        worktree: existsSync(ready.worktreePath),
      });
      expect(ready).toMatchObject({
        repoPath,
        branch: BRANCH,
        baseSha: r.baseSha,
        kept: [
          { title: 'Rule 1', why: 'Why 1', files: ['.apm/rules/a.md'] },
          { title: 'Rule 3', why: 'Why 3', files: ['.apm/rules/c.md'] },
        ],
      });
      return { as: 'pr', pr };
    });
    expect(out).toEqual({ as: 'pr', pr, branch: BRANCH });
    expect(seen).toEqual([
      { subjects: ['dream: Rule 1', 'dream: Rule 3'], worktree: true },
    ]);
    // The remote has the branch now: nothing of the dream stays on this machine.
    expect(existsSync(r.worktreePath)).toBe(false);
    expect(existsSync(r.dataDir)).toBe(false);
    expect(git(repoPath, 'branch', '--list', BRANCH).trim()).toBe('');
    const state = store.repo('r1');
    expect(state.result).toBeNull();
    expect(state.opened).toBeNull();
    expect(state.rejections.map((x) => x.title)).toEqual(['Rule 2']);
    expect(store.journal()[0].closed).toEqual({
      as: 'pr',
      kept: 2,
      dropped: 1,
      taskName: null,
      branch: BRANCH,
      pr,
    });
    expect(changed()).toBe(1);
  });

  it('still closes the dream when its folder cannot be removed after the send: the pull request is not lost', async () => {
    await dreamWithThree();
    vi.spyOn(deps.git as GitClient, 'worktreeRemove').mockRejectedValue(
      new Error('EBUSY: a file is locked'),
    );
    const out = await api().publish('r1', async () => ({ as: 'pr', pr }));
    expect(out).toMatchObject({ as: 'pr', pr });
    expect(store.repo('r1').result).toBeNull();
    expect(store.repo('r1').rejections).toEqual([]);
    expect(store.journal()[0].closed).toMatchObject({ as: 'pr', pr });
  });

  it('says the dream could not be sent, not opened, when the branch cannot be built', async () => {
    await dreamWithThree({ thirdEditsSecond: true });
    const a = api();
    // Proposal 3 edits the file proposal 2 adds: without 2 it does not apply.
    await a.handlers['dream:drop']('r1', 'p2', true);
    await expect(
      a.publish('r1', async () => ({ as: 'pushed' })),
    ).rejects.toThrow(/^The dream could not be sent$/);
    expect(store.repo('r1').result?.id).toBe(DREAM_ID);
  });

  it('closes as pushed, with the branch, where no pull request was made', async () => {
    await dreamWithThree();
    const out = await api().publish('r1', async () => ({ as: 'pushed' }));
    expect(out).toEqual({ as: 'pushed', branch: BRANCH });
    expect(store.journal()[0].closed).toMatchObject({
      as: 'pushed',
      branch: BRANCH,
    });
    expect(store.journal()[0].closed?.pr).toBeUndefined();
  });

  it('leaves the result open when send fails: a refusal in its own words, any other error as a fixed phrase', async () => {
    const r = await dreamWithThree();
    const a = api();
    await expect(
      a.publish('r1', async () => {
        throw dreamRefusal('Could not create the pull request');
      }),
    ).rejects.toThrow(/^Could not create the pull request$/);
    await expect(
      a.publish('r1', async () => {
        throw new Error('fatal: /Users/someone/customer-x');
      }),
    ).rejects.toThrow(/^The dream could not be sent$/);
    expect(store.repo('r1').result?.id).toBe(DREAM_ID);
    expect(existsSync(r.worktreePath)).toBe(true);
    expect(store.journal()[0].closed).toBeNull();
    // A second press goes through.
    expect(await a.publish('r1', async () => ({ as: 'pushed' }))).toMatchObject(
      { as: 'pushed' },
    );
  });

  it('refuses when every proposal is dropped, and keeps the dream', async () => {
    await dreamWithThree();
    const a = api();
    for (const id of ['p1', 'p2', 'p3'])
      await a.handlers['dream:drop']('r1', id, true);
    const send = vi.fn(async () => ({ as: 'pushed' as const }));
    await expect(a.publish('r1', send)).rejects.toThrow('Nothing left to push');
    expect(send).not.toHaveBeenCalled();
    expect(store.repo('r1').result?.id).toBe(DREAM_ID);
  });
});

describe('the briefing of a task made from a dream', () => {
  it('Open as task keeps what the agent is told: each kept proposal with its reason, files and evidence', async () => {
    await dreamWithThree();
    const a = api();
    await a.handlers['dream:drop']('r1', 'p2', true);
    await a.handlers['dream:openAsTask']('r1');
    const text = a.taskLink.briefing(DREAM_ID, 'r1');
    expect(text).toContain('## Dream');
    expect(text).toContain(`one commit on the branch \`${BRANCH}\``);
    expect(text).toContain('### 1. Rule 1');
    expect(text).toContain('- Why: Why 3');
    expect(text).not.toContain('Rule 2');
    // Only the dream that was opened, in its own repo.
    expect(a.taskLink.briefing('other', 'r1')).toBeNull();
    expect(a.taskLink.briefing(DREAM_ID, 'r2')).toBeNull();
  });

  it('is none for a record written before it was kept', async () => {
    await store.setOpened('r1', {
      dreamId: DREAM_ID,
      branch: BRANCH,
      at: '2026-11-20T03:00:00.000Z',
      kept: 1,
      titles: ['Rule 1'],
    });
    expect(api().taskLink.briefing(DREAM_ID, 'r1')).toBeNull();
  });
});

describe('asking for a change to a proposal', () => {
  const SESSION = `${JSON.stringify({ type: 'step_start', sessionID: 'ses_1' })}\n`;
  type RunOpts = {
    cwd: string;
    input: string;
    timeoutMs: number;
    signal: AbortSignal;
  };
  /** What the fake agent does in the worktree and the data folder; then it answers as OpenCode does. */
  const agent = (work: (wt: string, data: string, o: RunOpts) => void) =>
    run.mockImplementation(async (_cmd: unknown, o: RunOpts) => {
      work(o.cwd, store.repo('r1').result!.dataDir, o);
      return SESSION;
    });
  const note = (data: string, n: Record<string, unknown>) =>
    writeFileSync(path.join(data, 'adjust.json'), JSON.stringify(n));
  /** The run ended and the result says so: the start and the end each send `dream:changed`. */
  const ended = () =>
    vi.waitFor(() => expect(changed()).toBeGreaterThanOrEqual(2), {
      timeout: 15_000,
    });
  const ask = async (
    a: ReturnType<typeof api>,
    text = 'make it shorter',
    proposal = 'p2',
    quote?: string,
  ) => {
    vi.mocked(deps.broadcast).mockClear();
    await a.handlers['dream:adjust']('r1', proposal, text, quote);
    await ended();
  };
  const result = () => store.repo('r1').result!;
  const p2 = () => result().proposals[1];
  /** The proposal without its asks: what a failed or stopped ask must leave as it was. */
  const asIs = ({ adjustments: _asks, ...rest }: DreamProposal) => rest;
  const lastAsk = () => p2().adjustments?.at(-1);
  const show = (rev: string) => git(repoPath, 'show', rev);
  const dirty = (wt: string) =>
    git(wt, 'status', '--porcelain', '--ignored', '--untracked-files=all');
  const refs = () =>
    git(repoPath, 'for-each-ref', '--format=%(refname)', 'refs/shellie/')
      .trim()
      .split('\n')
      .filter(Boolean);

  beforeEach(async () => {
    await setDreaming(ready({ enabled: true }));
    deps.event = vi.fn();
  });

  it('an ask that edits the proposal’s file gives the proposal a new commit on the old one’s parent, with its files, title and reason', async () => {
    const r = await dreamWithThree();
    const old = r.proposals[1];
    const seen: unknown[] = [];
    agent((wt, data, o) => {
      seen.push(result().adjusting, o.timeoutMs, o.input);
      writeFileSync(path.join(wt, '.apm/rules/b.md'), 'rule 2, shorter\n');
      writeFileSync(path.join(wt, '.apm/rules/b-example.md'), 'an example\n');
      note(data, {
        title: 'Rule 2, short',
        why: 'Why 2, now shorter',
        note: 'Cut the second example.',
      });
    });
    const a = api();
    await ask(a, '  make it shorter  ', 'p2', `  ${'q'.repeat(700)}  `);

    // One run, as a dream's: its title and model, in the worktree, for at most 10 minutes.
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].args).toEqual(
      testPlatform().opencodeCommand(undefined, dreamArgs(MODEL, 'adjust', P))
        .args,
    );
    expect(run.mock.calls[0][1].cwd).toBe(r.worktreePath);
    expect(seen[0]).toMatchObject({
      proposalId: 'p2',
      ask: 'make it shorter',
      quote: 'q'.repeat(600),
    });
    expect(seen[1]).toBe(10 * 60_000);
    expect(seen[2]).toContain('make it shorter');

    const p = p2();
    expect(result().adjustFailed ?? null).toBeNull();
    expect(p.commit).not.toBe(old.commit);
    expect(git(repoPath, 'rev-parse', `${p.commit}^`)).toBe(
      git(repoPath, 'rev-parse', `${old.commit}^`),
    );
    expect(p).toMatchObject({
      title: 'Rule 2, short',
      why: 'Why 2, now shorter',
      files: ['.apm/rules/b-example.md', '.apm/rules/b.md'],
    });
    expect(p.adjustments).toEqual([
      {
        ask: 'make it shorter',
        quote: 'q'.repeat(600),
        at: expect.any(String),
        note: 'Cut the second example.',
        changed: true,
        reverted: [],
        outcome: 'changed',
        durationMs: expect.any(Number),
        before: {
          commit: old.commit,
          files: old.files,
          title: 'Rule 2',
          why: 'Why 2',
        },
      },
    ]);
    expect(result().adjusting ?? null).toBeNull();
    expect(result().adjustFailed ?? null).toBeNull();
    expect(show(`${p.commit}:.apm/rules/b.md`)).toBe('rule 2, shorter\n');
    expect(git(repoPath, 'log', '-1', '--format=%s', p.commit).trim()).toBe(
      'dream: Rule 2, short',
    );
    // The other proposals are as they were.
    expect(result().proposals[0]).toEqual(r.proposals[0]);
    expect(result().proposals[2]).toEqual(r.proposals[2]);

    // The worktree is the base plus the three proposals, with nothing uncommitted and no note file left.
    expect(dirty(r.worktreePath)).toBe('');
    expect(
      readFileSync(path.join(r.worktreePath, '.apm/rules/b.md'), 'utf8'),
    ).toBe('rule 2, shorter\n');
    expect(
      git(repoPath, 'rev-list', '--count', `${r.baseSha}..${BRANCH}`).trim(),
    ).toBe('3');
    expect(existsSync(path.join(r.dataDir, 'adjust.json'))).toBe(false);

    // The diff reads the changed proposal with no change of its own.
    const diff = await a.handlers['dream:diff']('r1', 'p2');
    expect(diff.map((f) => f.path)).toEqual([
      '.apm/rules/b-example.md',
      '.apm/rules/b.md',
    ]);
    expect(diff[1].hunks[0].lines).toEqual([
      { kind: 'add', text: 'rule 2, shorter', oldNo: null, newNo: 1 },
    ]);

    // Both commits stay reachable while the dream is open.
    expect(refs().sort()).toEqual(
      [old.commit, p.commit]
        .map((c) => `refs/shellie/dreams/${DREAM_ID}/${c}`)
        .sort(),
    );
    expect(deps.event).toHaveBeenCalledWith('dream.adjust', {
      outcome: 'changed',
    });
  });

  it('an ask that is only answered adds the answer and leaves the commit, title and reason', async () => {
    const r = await dreamWithThree();
    agent((_wt, data) =>
      note(data, {
        title: 'Another title',
        why: 'Another reason',
        note: 'It is about the build step.',
      }),
    );
    await ask(api(), 'what is this about?');
    expect(p2()).toEqual({
      ...r.proposals[1],
      adjustments: [
        {
          ask: 'what is this about?',
          at: expect.any(String),
          note: 'It is about the build step.',
          changed: false,
          reverted: [],
          outcome: 'answer',
          durationMs: expect.any(Number),
        },
      ],
    });
    expect(refs()).toEqual([]);
    expect(deps.event).toHaveBeenCalledWith('dream.adjust', {
      outcome: 'answered',
    });
  });

  it('puts back edits to another proposal’s file, outside the allowed folders and to protected paths, and names them', async () => {
    const r = await dreamWithThree();
    commitFile(repoPath, 'README.md', 'read me\n', 'readme');
    agent((wt, data) => {
      writeFileSync(path.join(wt, '.apm/rules/b.md'), 'rule 2, changed\n');
      writeFileSync(path.join(wt, '.apm/rules/a.md'), 'not mine\n');
      writeFileSync(path.join(wt, 'outside.md'), 'outside\n');
      mkdirSync(path.join(wt, '.apm/hooks'));
      writeFileSync(path.join(wt, '.apm/hooks/run.sh'), 'echo hi\n');
      note(data, { note: 'x'.repeat(1200), title: 't'.repeat(201), why: '' });
    });
    await ask(api());
    const p = p2();
    expect(p.files).toEqual(['.apm/rules/b.md']);
    // A title too long and an empty reason are not taken; a long note is cut.
    expect(p.title).toBe('Rule 2');
    expect(p.why).toBe('Why 2');
    expect(p.adjustments![0]).toMatchObject({
      changed: true,
      reverted: ['.apm/hooks/run.sh', '.apm/rules/a.md', 'outside.md'],
    });
    expect(p.adjustments![0].note).toHaveLength(1000);
    expect(dirty(r.worktreePath)).toBe('');
    expect(
      readFileSync(path.join(r.worktreePath, '.apm/rules/a.md'), 'utf8'),
    ).toBe('rule 1\n');
    expect(existsSync(path.join(r.worktreePath, 'outside.md'))).toBe(false);
    expect(existsSync(path.join(r.worktreePath, '.apm/hooks'))).toBe(false);
    expect(
      git(repoPath, 'ls-tree', '-r', '--name-only', p.commit)
        .trim()
        .split('\n'),
    ).toEqual(['.apm/rules/a.md', '.apm/rules/b.md', 'README.md']);
  });

  it('only what was put back, and no note: the ask is kept with "No note"', async () => {
    await dreamWithThree();
    agent((wt) => writeFileSync(path.join(wt, 'outside.md'), 'outside\n'));
    await ask(api());
    expect(p2().adjustments).toEqual([
      expect.objectContaining({
        note: 'No note',
        changed: false,
        reverted: ['outside.md'],
      }),
    ]);
  });

  it('nothing changed and no note: the ask failed, and can be offered again', async () => {
    const r = await dreamWithThree();
    agent(() => undefined);
    await ask(api(), 'make it shorter', 'p2', 'rule 2');
    expect(asIs(p2())).toEqual(r.proposals[1]);
    expect(result().adjusting ?? null).toBeNull();
    expect(result().adjustFailed ?? null).toBeNull();
    expect(p2().adjustments).toEqual([
      {
        ask: 'make it shorter',
        quote: 'rule 2',
        at: expect.any(String),
        note: '',
        changed: false,
        reverted: [],
        outcome: 'failed',
        reason: 'The agent changed nothing',
        durationMs: expect.any(Number),
      },
    ]);
    expect(deps.event).toHaveBeenCalledWith('dream.adjust', {
      outcome: 'failed',
    });
  });

  it('a change that would empty the proposal fails', async () => {
    const r = await dreamWithThree();
    agent((wt) => rmSync(path.join(wt, '.apm/rules/b.md')));
    await ask(api());
    expect(asIs(p2())).toEqual(r.proposals[1]);
    expect(lastAsk()).toMatchObject({
      outcome: 'failed',
      reason: 'The change would leave the proposal empty: drop it instead',
    });
    expect(existsSync(path.join(r.worktreePath, '.apm/rules/b.md'))).toBe(true);
  });

  it('a failing run leaves the proposal as it was, the worktree rebuilt, and says why in a fixed phrase', async () => {
    const r = await dreamWithThree();
    run.mockImplementation(async (_cmd: unknown, o: RunOpts) => {
      writeFileSync(path.join(o.cwd, '.apm/rules/b.md'), 'half done\n');
      writeFileSync(path.join(o.cwd, 'left.txt'), 'left\n');
      throw new ExitError(`fatal: ${o.cwd} secret output`, 1, 'session text');
    });
    await ask(api());
    expect(asIs(p2())).toEqual(r.proposals[1]);
    expect(lastAsk()).toMatchObject({
      ask: 'make it shorter',
      outcome: 'failed',
      reason: 'OpenCode stopped',
    });
    expect(lastAsk()).not.toHaveProperty('fix');
    expect(dirty(r.worktreePath)).toBe('');
    expect(
      readFileSync(path.join(r.worktreePath, '.apm/rules/b.md'), 'utf8'),
    ).toBe('rule 2\n');
    // The next ask takes the failed row's place.
    agent((_wt, data) => note(data, { note: 'An answer.' }));
    await ask(api());
    expect(p2().adjustments).toEqual([
      expect.objectContaining({ outcome: 'answer', note: 'An answer.' }),
    ]);
  });

  it('a run that times out says so', async () => {
    await dreamWithThree();
    run.mockRejectedValue(new Error('opencode timed out after 600000 ms'));
    await ask(api());
    expect(lastAsk()).toMatchObject({
      outcome: 'failed',
      reason: 'timed out after 10 min',
    });
  });

  it('Stop ends the run: the proposal stays as it was and the ask is offered again', async () => {
    const r = await dreamWithThree();
    run.mockImplementation(
      (_cmd: unknown, o: RunOpts) =>
        new Promise<string>((_resolve, reject) => {
          writeFileSync(path.join(o.cwd, '.apm/rules/b.md'), 'half done\n');
          o.signal.addEventListener('abort', () => reject(new Error('killed')));
        }),
    );
    const a = api();
    vi.mocked(deps.broadcast).mockClear();
    await a.handlers['dream:adjust']('r1', 'p2', 'make it shorter');
    expect(changed()).toBe(1);
    expect(result().adjusting).toMatchObject({ proposalId: 'p2' });
    await a.handlers['dream:adjustStop']('r1');
    await ended();
    expect(asIs(p2())).toEqual(r.proposals[1]);
    expect(result().adjusting ?? null).toBeNull();
    expect(result().adjustFailed ?? null).toBeNull();
    expect(p2().adjustments).toEqual([
      {
        ask: 'make it shorter',
        at: expect.any(String),
        note: '',
        changed: false,
        reverted: [],
        outcome: 'stopped',
        durationMs: expect.any(Number),
      },
    ]);
    expect(dirty(r.worktreePath)).toBe('');
    expect(deps.event).toHaveBeenCalledWith('dream.adjust', {
      outcome: 'stopped',
    });
    // Stop with no run does nothing.
    await a.handlers['dream:adjustStop']('r1');
    expect(changed()).toBe(2);
  });

  it('Undo finds the latest change under a stopped ask', async () => {
    const r = await dreamWithThree();
    const a = api();
    agent((wt, data) => {
      writeFileSync(path.join(wt, '.apm/rules/b.md'), 'first change\n');
      note(data, { note: 'Changed once.' });
    });
    await ask(a, 'one');
    await store.updateResult('r1', r.id, (x) => {
      x.adjusting = { proposalId: 'p2', ask: 'left', startedAt: 1 };
    });
    await a.handlers['dream:adjustStop']('r1');
    expect(p2().adjustments!.map((x) => x.outcome)).toEqual([
      'changed',
      'stopped',
    ]);
    await a.handlers['dream:adjustUndo']('r1', 'p2');
    expect(p2()).toEqual({ ...r.proposals[1], adjustments: [] });
  });

  it('Stop clears an ask the result still names when no run is under way', async () => {
    const r = await dreamWithThree();
    await store.updateResult('r1', r.id, (x) => {
      x.adjusting = { proposalId: 'p2', ask: 'left', startedAt: 1 };
    });
    await api().handlers['dream:adjustStop']('r1');
    expect(result().adjusting).toBeNull();
    expect(lastAsk()).toMatchObject({ ask: 'left', outcome: 'stopped' });
    expect(changed()).toBe(1);
  });

  it('Undo takes back the latest change and the answers after it', async () => {
    const r = await dreamWithThree();
    const a = api();
    agent((wt, data) => {
      writeFileSync(path.join(wt, '.apm/rules/b.md'), 'first change\n');
      note(data, { title: 'First', why: 'Why first', note: 'Changed once.' });
    });
    await ask(a, 'one');
    const first = p2();
    agent((wt, data) => {
      writeFileSync(path.join(wt, '.apm/rules/b.md'), 'second change\n');
      note(data, { title: 'Second', note: 'Changed twice.' });
    });
    await ask(a, 'two');
    agent((_wt, data) => note(data, { note: 'An answer.' }));
    await ask(a, 'three?');
    expect(p2().adjustments!.map((x) => x.changed)).toEqual([
      true,
      true,
      false,
    ]);
    expect(p2().adjustments!.map((x) => x.outcome)).toEqual([
      'changed',
      'changed',
      'answer',
    ]);
    expect(p2().adjustments![0].durationMs).toEqual(expect.any(Number));

    vi.mocked(deps.broadcast).mockClear();
    await a.handlers['dream:adjustUndo']('r1', 'p2');
    expect(changed()).toBe(1);
    expect(p2()).toEqual(first);
    expect(
      readFileSync(path.join(r.worktreePath, '.apm/rules/b.md'), 'utf8'),
    ).toBe('first change\n');
    expect(dirty(r.worktreePath)).toBe('');

    await a.handlers['dream:adjustUndo']('r1', 'p2');
    expect(p2()).toEqual({ ...r.proposals[1], adjustments: [] });
    expect(
      readFileSync(path.join(r.worktreePath, '.apm/rules/b.md'), 'utf8'),
    ).toBe('rule 2\n');
    await expect(a.handlers['dream:adjustUndo']('r1', 'p2')).rejects.toThrow(
      'This proposal has no change to take back',
    );
    await expect(a.handlers['dream:adjustUndo']('r1', 'p9')).rejects.toThrow(
      'This dream has no such proposal',
    );
  });

  it('refuses a dropped or unknown proposal, an empty or too long ask, and a dream whose worktree is gone', async () => {
    const r = await dreamWithThree();
    const h = api().handlers;
    await h['dream:drop']('r1', 'p3', true);
    vi.mocked(deps.broadcast).mockClear();
    await expect(h['dream:adjust']('r1', 'p3', 'shorter')).rejects.toThrow(
      'Take the proposal back to change it',
    );
    await expect(h['dream:adjust']('r1', 'p9', 'shorter')).rejects.toThrow(
      'This dream has no such proposal',
    );
    await expect(h['dream:adjust']('r2', 'p1', 'shorter')).rejects.toThrow(
      'This repo has no dream to review',
    );
    for (const empty of ['', '  \n ', undefined, 7])
      await expect(
        h['dream:adjust']('r1', 'p2', empty as unknown as string),
      ).rejects.toThrow('Type what should change');
    await expect(
      h['dream:adjust']('r1', 'p2', 'x'.repeat(4001)),
    ).rejects.toThrow('The ask is too long: at most 4 000 characters');
    rmSync(r.worktreePath, { recursive: true });
    await expect(h['dream:adjust']('r1', 'p2', 'shorter')).rejects.toThrow(
      "This dream's files are gone: it can be sent or discarded, not changed",
    );
    expect(run).not.toHaveBeenCalled();
    expect(changed()).toBe(0);
    expect(result().adjusting ?? null).toBeNull();
  });

  it('refuses without a tested dream model, and for a repo that is not set up to dream', async () => {
    await dreamWithThree();
    const h = api().handlers;
    await setDreaming(ready({ testedModel: null }));
    await expect(h['dream:adjust']('r1', 'p2', 'shorter')).rejects.toThrow(
      'Test the dreaming model first',
    );
    await setDreaming(
      ready({ repos: { r1: { on: false, folders: ['.apm'] } } }),
    );
    await expect(h['dream:adjust']('r1', 'p2', 'shorter')).rejects.toThrow(
      'This repo is not set up to dream',
    );
    started = false;
    await expect(h['dream:adjust']('r1', 'p2', 'shorter')).rejects.toThrow(
      'Dreams are still starting',
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('while a run is under way: no second ask, no Undo, no pull request and no task; Discard stops it first', async () => {
    const r = await dreamWithThree();
    run.mockImplementation(
      (_cmd: unknown, o: RunOpts) =>
        new Promise<string>((_resolve, reject) => {
          o.signal.addEventListener('abort', () => reject(new Error('killed')));
        }),
    );
    const a = api();
    await a.handlers['dream:adjust']('r1', 'p2', 'make it shorter');
    await expect(
      a.handlers['dream:adjust']('r1', 'p1', 'another'),
    ).rejects.toThrow('A change is already being made');
    const busy = 'A change is being made: stop it or wait for it first';
    await expect(a.handlers['dream:adjustUndo']('r1', 'p2')).rejects.toThrow(
      busy,
    );
    const send = vi.fn();
    await expect(a.publish('r1', send)).rejects.toThrow(busy);
    await expect(a.handlers['dream:openAsTask']('r1')).rejects.toThrow(busy);
    expect(send).not.toHaveBeenCalled();
    expect(result().adjusting).toMatchObject({ proposalId: 'p2' });
    expect(run).toHaveBeenCalledOnce();

    await a.handlers['dream:discard']('r1');
    expect(run.mock.calls[0][1].signal.aborted).toBe(true);
    expect(store.repo('r1').result).toBeNull();
    expect(existsSync(r.worktreePath)).toBe(false);
    expect(deps.event).toHaveBeenCalledWith('dream.adjust', {
      outcome: 'stopped',
    });
  });

  it('after an ask, sending the branch carries the changed commit, and the kept commits go with the dream', async () => {
    await dreamWithThree();
    const a = api();
    agent((wt, data) => {
      writeFileSync(path.join(wt, '.apm/rules/b.md'), 'rule 2, shorter\n');
      note(data, { title: 'Rule 2, short', note: 'Shorter.' });
    });
    await ask(a);
    expect(refs()).toHaveLength(2);
    await a.handlers['dream:drop']('r1', 'p1', true);
    const seen: unknown[] = [];
    await a.publish('r1', async (ready) => {
      seen.push(
        ready.kept.map((k) => k.title),
        show(`${ready.branch}:.apm/rules/b.md`),
        git(
          repoPath,
          'log',
          '--format=%s',
          '--reverse',
          `${ready.baseSha}..${ready.branch}`,
        )
          .trim()
          .split('\n'),
      );
      return { as: 'pushed' };
    });
    expect(seen).toEqual([
      ['Rule 2, short', 'Rule 3'],
      'rule 2, shorter\n',
      ['dream: Rule 2, short', 'dream: Rule 3'],
    ]);
    expect(refs()).toEqual([]);
  });

  it('another model answering switches dreaming off as after a dream, and changes nothing', async () => {
    const r = await dreamWithThree();
    answered = [MODEL, OTHER];
    agent((wt, data) => {
      writeFileSync(path.join(wt, '.apm/rules/b.md'), 'by another model\n');
      note(data, { note: 'Changed.' });
    });
    await ask(api());
    expect(scheduler.switchOffModel).toHaveBeenCalledWith({
      project: P,
      model: MODEL,
      answered: OTHER,
      repoId: 'r1',
    });
    expect(asIs(p2())).toEqual(r.proposals[1]);
    expect(lastAsk()).toMatchObject({
      outcome: 'failed',
      reason: 'Another model answered',
      fix: 'settings',
    });
    expect(dirty(r.worktreePath)).toBe('');
    expect(
      readFileSync(path.join(r.worktreePath, '.apm/rules/b.md'), 'utf8'),
    ).toBe('rule 2\n');
  });

  it('an ask left by a quit is cleared at the start, with the phrase for the page', async () => {
    const r = await dreamWithThree();
    await store.updateResult('r1', r.id, (x) => {
      x.adjusting = {
        proposalId: 'p2',
        ask: 'make it shorter',
        quote: 'rule 2',
        startedAt: 1,
      };
    });
    const next = new DreamStore(dir);
    await next.load();
    const written = vi.fn();
    next.onChange(written);
    await next.clearLeftAsks(ASK_LEFT_BY_QUIT);
    expect(next.repo('r1').result?.adjusting).toBeNull();
    expect(
      next.repo('r1').result?.proposals.find((x) => x.id === 'p2')?.adjustments,
    ).toEqual([
      expect.objectContaining({
        ask: 'make it shorter',
        quote: 'rule 2',
        outcome: 'failed',
        reason: 'Shellie was closed while the change was being made',
      }),
    ]);
    // Nothing left: nothing written.
    await next.clearLeftAsks(ASK_LEFT_BY_QUIT);
    expect(written).toHaveBeenCalledOnce();
  });
});
