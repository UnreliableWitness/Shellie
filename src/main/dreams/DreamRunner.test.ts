import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../services/GitClient';
import { runWithInput } from '../services/prSummary';
import { fakeOpencode, type FakeRun } from '../test-helpers/fakeOpencode';
import {
  addOrigin,
  cleanupTempRepos,
  git,
  makeRepo,
} from '../test-helpers/gitRepo';
import { DreamStore } from './DreamStore';
import { DreamRunner, type DreamRunnerDeps } from './DreamRunner';
import type { TaskSessions } from './material';

const MODEL = 'zai/glm-5';
/** Local noon on 2026-11-20: the dream date is the local date. */
const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();
const DATE = '2026-11-20';

const task = (id: string): TaskSessions => ({
  taskId: id,
  label: `Label ${id}`,
  workItemId: 7,
  createdAt: '2026-11-19T10:00:00.000Z',
  agents: ['opencode'],
  sessions: [
    [
      { who: 'Developer', text: 'use the helper', at: NOW - 5000 },
      { who: 'Claude', text: 'ok', at: NOW - 4000 },
    ],
  ],
});

const proposal = (
  title: string,
  file: string,
  taskRef = 't1',
): Record<string, unknown> => ({
  kind: 'new-rule',
  title,
  why: `Because ${title}.`,
  evidence: [{ task: taskRef, date: '2026-11-19', quote: 'use the helper' }],
  files: [file],
});

const report = (...proposals: Record<string, unknown>[]) => ({
  proposals,
  sightings: [{ note: 'seen once', task: 't1', quote: 'hmm' }],
});

/** Propose two rules in .apm/, both pass the check. */
const twoProposals = (): FakeRun[] => [
  {
    sessionId: 'ses_p',
    edits: { '.apm/rules/a.md': 'A\n', '.apm/rules/b.md': 'B\n' },
    report: report(
      proposal('Rule A', '.apm/rules/a.md'),
      proposal('Rule B', '.apm/rules/b.md'),
    ),
  },
  { sessionId: 'ses_c', verdicts: ['pass', 'pass'] },
];

let repo: string;
let bare: string;
let root: string;
let dreamsDir: string;
let store: DreamStore;
let fake: ReturnType<typeof fakeOpencode> | null = null;
let models: Record<string, string[]>;
let limited: boolean;
let tasks: TaskSessions[];

beforeEach(async () => {
  repo = makeRepo();
  mkdirSync(path.join(repo, '.apm'));
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, '.apm', 'keep.md'), 'keep\n');
  writeFileSync(path.join(repo, 'src', 'app.ts'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base files');
  bare = addOrigin(repo);
  root = path.dirname(repo);
  dreamsDir = path.join(root, 'userdata', 'dreams');
  store = new DreamStore(path.join(root, 'userdata'), () => NOW);
  await store.load();
  models = {};
  limited = false;
  tasks = [task('t1')];
});

afterEach(() => {
  vi.useRealTimers();
  fake?.dispose();
  fake = null;
  cleanupTempRepos();
});

function runner(runs: FakeRun[], over: Partial<DreamRunnerDeps> = {}) {
  fake = fakeOpencode(runs);
  return new DreamRunner({
    git: new GitClient(),
    platform: fake.platform,
    run: runWithInput,
    store,
    dreamsDir,
    sessionsOf: async () => tasks,
    sessionModels: (id) => models[id] ?? [MODEL],
    dreamTokens: () => 1234,
    baseBranch: async () => 'main',
    now: () => NOW,
    overLimit: () => limited,
    ...over,
  });
}

const repoArg = () => ({ id: 'r1', path: repo, name: 'repo' });
const opts = (signal = new AbortController().signal) => ({
  model: MODEL,
  folders: ['.apm'],
  signal,
});

const dreamBranches = (cwd = repo): string[] =>
  git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/dream')
    .split('\n')
    .filter(Boolean);

/** Nothing of a dream is left: no folder under the repo's dreams folder, no dream branch, one worktree. */
function expectNothingLeft(): void {
  const dir = path.join(dreamsDir, 'r1');
  expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  expect(dreamBranches()).toEqual([]);
  expect(
    git(repo, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree ')),
  ).toHaveLength(1);
}

const show = (cwd: string, ...args: string[]) => git(cwd, ...args).trim();

describe('DreamRunner', () => {
  it('commits each proposal on a new dream branch and stores the result', async () => {
    const headBefore = show(repo, 'rev-parse', 'HEAD');
    const r = runner(twoProposals());
    const out = await r.dream(repoArg(), opts());
    expect(out.outcome).toBe('proposed');
    if (out.outcome !== 'proposed') return;
    const { result } = out;
    expect(result.branch).toBe(`dream/${DATE}-1`);
    expect(result.id).toBe(`${DATE}-1`);
    expect(result.baseSha).toBe(headBefore);
    const commits = show(
      repo,
      'rev-list',
      '--reverse',
      `${headBefore}..${result.branch}`,
    ).split('\n');
    expect(commits).toHaveLength(2);
    expect(result.proposals.map((p) => p.commit)).toEqual(commits);
    expect(show(repo, 'log', '-1', '--format=%s%n%b', commits[0])).toBe(
      'dream: Rule A\nBecause Rule A.',
    );
    expect(show(repo, 'show', '--name-only', '--format=', commits[1])).toBe(
      '.apm/rules/b.md',
    );
    expect(result.proposals[0]).toMatchObject({
      id: 'p1',
      kind: 'new-rule',
      title: 'Rule A',
      files: ['.apm/rules/a.md'],
      dropped: false,
      evidence: [{ taskId: 't1', label: 'Label t1', quote: 'use the helper' }],
    });
    expect(result).toMatchObject({
      repoId: 'r1',
      model: MODEL,
      tokens: 1234,
      sessions: 1,
      reverted: [],
      removedByCheck: 0,
    });
    // The worktree and data live side by side in the dream's folder.
    expect(existsSync(path.join(result.worktreePath, '.apm/rules/a.md'))).toBe(
      true,
    );
    expect(path.dirname(result.dataDir)).toBe(
      path.dirname(result.worktreePath),
    );
    // The main checkout did not move and nothing was pushed.
    expect(show(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(show(repo, 'status', '--porcelain')).toBe('');
    expect(dreamBranches(bare)).toEqual([]);
    // The store has it all.
    const state = store.repo('r1');
    expect(state.result?.id).toBe(result.id);
    expect(state.covered).toEqual({ t1: NOW - 4000 });
    expect(state.sightings).toMatchObject([
      { note: 'seen once', taskId: 't1' },
    ]);
    expect(store.journal()).toMatchObject([
      {
        dreamId: result.id,
        outcome: 'proposed',
        model: MODEL,
        tokens: 1234,
        proposals: 2,
        reason: null,
      },
    ]);
    // Both runs ran in the worktree with the dream's env, the check after the propose run.
    const calls = fake!.calls();
    expect(calls.map((c) => c.args.slice(0, 7))).toEqual([
      [
        'run',
        '--format',
        'json',
        '--title',
        'Shellie dream: propose',
        '-m',
        MODEL,
      ],
      [
        'run',
        '--format',
        'json',
        '--title',
        'Shellie dream: check',
        '-m',
        MODEL,
      ],
    ]);
    for (const c of calls) {
      expect(c.cwd).toBe(result.worktreePath);
      expect(c.env.PWD).toBe(result.worktreePath);
      expect(c.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
      expect(c.env.OPENCODE_CONFIG_CONTENT).toContain(MODEL);
    }
    expect(calls[0].input).toContain(`${result.dataDir}/report.json`);
    expect(r.running()).toBeNull();
  });

  it('maps evidence to tasks by id, digest file or label, and keeps an unknown one as given', async () => {
    tasks = [task('t1'), { ...task('t2'), label: 'Fix the login page' }];
    const runs = twoProposals();
    const p = proposal('Rule A', '.apm/rules/a.md');
    p.evidence = ['tasks/t1.md', 'the login page', 'nope'].map((t) => ({
      task: t,
      date: '2026-11-19',
      quote: 'q',
    }));
    runs[0].report = report(p, proposal('Rule B', '.apm/rules/b.md'));
    const out = await runner(runs).dream(repoArg(), opts());
    if (out.outcome !== 'proposed') throw new Error(out.outcome);
    expect(
      out.result.proposals[0].evidence.map((e) => [e.taskId, e.label]),
    ).toEqual([
      ['t1', 'Label t1'],
      ['t2', 'Fix the login page'],
      ['nope', 'nope'],
    ]);
    expect(out.result.sessions).toBe(2);
  });

  it('takes the next free number when the dream branch exists', async () => {
    git(repo, 'branch', `dream/${DATE}-1`);
    const out = await runner(twoProposals()).dream(repoArg(), opts());
    expect(out.outcome === 'proposed' && out.result.branch).toBe(
      `dream/${DATE}-2`,
    );
  });

  it('reverts a change outside the allowed folders and commits none of it', async () => {
    const runs = twoProposals();
    runs[0].edits!['src/app.ts'] = 'changed\n';
    const out = await runner(runs).dream(repoArg(), opts());
    expect(out.outcome).toBe('proposed');
    if (out.outcome !== 'proposed') return;
    expect(out.result.reverted).toEqual(['src/app.ts']);
    expect(
      readFileSync(path.join(out.result.worktreePath, 'src/app.ts'), 'utf8'),
    ).toBe('base\n');
    expect(
      show(
        repo,
        'log',
        '--name-only',
        '--format=',
        `main..${out.result.branch}`,
      ),
    ).not.toContain('src/app.ts');
    expect(show(out.result.worktreePath, 'status', '--porcelain')).toBe('');
  });

  it('reverts OpenCode config in an allowed folder and an allowed change no proposal lists', async () => {
    const runs = twoProposals();
    runs[0].edits!['.apm/OpenCode.json'] = '{}';
    runs[0].edits!['.apm/keep.md'] = 'edited\n';
    runs[0].edits!['.apm/stray.md'] = 'stray\n';
    const out = await runner(runs).dream(repoArg(), opts());
    if (out.outcome !== 'proposed') throw new Error(out.outcome);
    expect(out.result.reverted).toEqual(['.apm/OpenCode.json']);
    const wt = out.result.worktreePath;
    expect(existsSync(path.join(wt, '.apm/OpenCode.json'))).toBe(false);
    expect(existsSync(path.join(wt, '.apm/stray.md'))).toBe(false);
    expect(readFileSync(path.join(wt, '.apm/keep.md'), 'utf8')).toBe('keep\n');
    expect(show(wt, 'status', '--porcelain')).toBe('');
  });

  it('commits only the proposals that pass the check', async () => {
    const runs = twoProposals();
    runs[1].verdicts = ['pass', 'fail'];
    const out = await runner(runs).dream(repoArg(), opts());
    if (out.outcome !== 'proposed') throw new Error(out.outcome);
    expect(out.result.proposals.map((p) => p.title)).toEqual(['Rule A']);
    expect(out.result.removedByCheck).toBe(1);
    expect(
      show(repo, 'rev-list', '--count', `main..${out.result.branch}`),
    ).toBe('1');
    expect(
      existsSync(path.join(out.result.worktreePath, '.apm/rules/b.md')),
    ).toBe(false);
    expect(store.journal()).toMatchObject([
      { outcome: 'proposed', proposals: 1, removedByCheck: 1 },
    ]);
  });

  it('ends with nothing when the report has no proposals', async () => {
    const r = runner([
      { sessionId: 'ses_p', edits: { '.apm/x.md': 'x' }, report: report() },
    ]);
    const out = await r.dream(repoArg(), opts());
    expect(out).toEqual({ outcome: 'nothing' });
    expect(fake!.calls()).toHaveLength(1);
    expectNothingLeft();
    const state = store.repo('r1');
    expect(state.sightings).toHaveLength(1);
    expect(state.covered).toEqual({ t1: NOW - 4000 });
    expect(state.lastOutcome).toBe('nothing');
    expect(store.journal()).toMatchObject([
      { outcome: 'nothing', tokens: 1234, proposals: 0, reason: null },
    ]);
  });

  it('throws the dream away when another model answered the propose run', async () => {
    models.ses_p = ['other/model'];
    const out = await runner(twoProposals()).dream(repoArg(), opts());
    expect(out).toEqual({ outcome: 'wrong-model', answered: ['other/model'] });
    expect(fake!.calls()).toHaveLength(1);
    expectNothingLeft();
    expect(store.repo('r1').covered).toEqual({});
    expect(store.journal()).toMatchObject([{ outcome: 'wrong-model' }]);
  });

  it('throws the dream away when another model answered the check run', async () => {
    models.ses_c = [MODEL, 'other/model'];
    const out = await runner(twoProposals()).dream(repoArg(), opts());
    expect(out).toEqual({ outcome: 'wrong-model', answered: ['other/model'] });
    expectNothingLeft();
    expect(store.repo('r1').result).toBeNull();
  });

  it('fails without a readable report and removes everything', async () => {
    const out = await runner([
      { sessionId: 'ses_p', edits: { '.apm/x.md': 'x' }, report: 'not json' },
    ]).dream(repoArg(), opts());
    expect(out).toEqual({
      outcome: 'failed',
      reason: 'The dream left no readable report',
    });
    expectNothingLeft();
    expect(store.repo('r1').failures).toBe(1);
    expect(store.repo('r1').covered).toEqual({});
    expect(store.journal()).toMatchObject([
      { outcome: 'failed', reason: 'The dream left no readable report' },
    ]);
  });

  it('fails when OpenCode exits 1, without its output in the reason', async () => {
    const out = await runner([{ exitCode: 1 }]).dream(repoArg(), opts());
    expect(out).toEqual({ outcome: 'failed', reason: 'OpenCode stopped' });
    expectNothingLeft();
    expect(JSON.stringify(store.journal())).not.toContain('secret');
    expect(store.repo('r1').lastFailure).toBe('OpenCode stopped');
  });

  it('is interrupted when the signal aborts mid-run', async () => {
    const marker = path.join(root, 'started');
    const r = runner([{ startedMarker: marker, sleepMs: 60_000 }]);
    const ac = new AbortController();
    const done = r.dream(repoArg(), opts(ac.signal));
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {
      timeout: 10_000,
    });
    expect(r.running()).toMatchObject({
      repoId: 'r1',
      startedAt: NOW,
      step: 'reading',
    });
    ac.abort();
    expect(await done).toEqual({ outcome: 'interrupted', why: 'stopped' });
    expectNothingLeft();
    expect(store.journal()).toMatchObject([
      { outcome: 'interrupted', reason: 'stopped' },
    ]);
    expect(store.repo('r1').failures).toBe(0);
    expect(r.running()).toBeNull();
  });

  it('is interrupted at the limit, checked every 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const marker = path.join(root, 'started');
    const r = runner([{ startedMarker: marker, sleepMs: 60_000 }]);
    const done = r.dream(repoArg(), opts());
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {
      timeout: 10_000,
    });
    vi.advanceTimersByTime(30_000);
    limited = true;
    vi.advanceTimersByTime(29_000);
    expect(r.running()).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(await done).toEqual({ outcome: 'interrupted', why: 'limit' });
    expectNothingLeft();
    expect(store.journal()).toMatchObject([{ outcome: 'limit' }]);
    expect(store.repo('r1').covered).toEqual({});
  });

  it('runs from the local target branch when the fetch fails', async () => {
    rmSync(bare, { recursive: true, force: true });
    writeFileSync(path.join(repo, 'local.txt'), 'local\n');
    git(repo, 'add', 'local.txt');
    git(repo, 'commit', '-q', '-m', 'local only');
    const head = show(repo, 'rev-parse', 'HEAD');
    const out = await runner(twoProposals()).dream(repoArg(), opts());
    if (out.outcome !== 'proposed') throw new Error(out.outcome);
    expect(out.result.baseSha).toBe(head);
  });

  it('does nothing, and logs nothing, without material', async () => {
    tasks = [];
    const before = show(repo, 'worktree', 'list', '--porcelain');
    const out = await runner(twoProposals()).dream(repoArg(), opts());
    expect(out).toEqual({ outcome: 'nothing' });
    expect(show(repo, 'worktree', 'list', '--porcelain')).toBe(before);
    expect(fake!.calls()).toHaveLength(0);
    expect(store.journal()).toEqual([]);
    expect(existsSync(dreamsDir)).toBe(false);
  });
});
