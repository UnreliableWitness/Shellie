import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it('keeps only proposals with a quote of the developer, and says who said each quote', async () => {
    tasks = [
      {
        ...task('t1'),
        sessions: [
          [
            { who: 'Developer', text: 'use the helper', at: NOW - 5000 },
            {
              who: 'Claude',
              text: 'I used the helper everywhere',
              at: NOW - 4000,
            },
          ],
        ],
      },
    ];
    const withQuotes = (title: string, file: string, quotes: string[]) => ({
      ...proposal(title, file),
      evidence: quotes.map((quote) => ({
        task: 't1',
        date: '2026-11-19',
        quote,
      })),
    });
    const out = await runner([
      {
        sessionId: 'ses_p',
        edits: { '.apm/rules/a.md': 'A\n', '.apm/rules/b.md': 'B\n' },
        report: report(
          withQuotes('Rule A', '.apm/rules/a.md', [
            '**Claude:** I used the helper everywhere',
            '**Developer:** use the helper',
            'something nobody said at all',
          ]),
          withQuotes('Rule B', '.apm/rules/b.md', [
            'I used the helper everywhere',
          ]),
        ),
      },
      { sessionId: 'ses_c', verdicts: ['pass', 'pass'] },
    ]).dream(repoArg(), opts());
    expect(out.outcome).toBe('proposed');
    if (out.outcome !== 'proposed') return;
    expect(out.result.proposals.map((p) => p.title)).toEqual(['Rule A']);
    expect(out.result.proposals[0].evidence.map((e) => e.who)).toEqual([
      'agent',
      'you',
      'unknown',
    ]);
    // Stored as the words that were looked for: no digest label in the quote the screen shows.
    expect(out.result.proposals[0].evidence.map((e) => e.quote)).toEqual([
      'I used the helper everywhere',
      'use the helper',
      'something nobody said at all',
    ]);
    expect(out.result.removedByCheck).toBe(1);
    // Rule B's file is reverted like a failed proposal's: not on the branch, not in the worktree.
    expect(
      show(repo, 'show', '--name-only', '--format=', out.result.branch),
    ).toBe('.apm/rules/a.md');
    expect(
      existsSync(path.join(out.result.worktreePath, '.apm/rules/b.md')),
    ).toBe(false);
    expect(store.journal()[0]).toMatchObject({
      proposals: 1,
      removedByCheck: 1,
    });
  });

  it('ends with nothing when no proposal has a quote of the developer', async () => {
    const out = await runner([
      {
        sessionId: 'ses_p',
        edits: { '.apm/rules/a.md': 'A\n' },
        report: report({
          ...proposal('Rule A', '.apm/rules/a.md'),
          evidence: [
            { task: 't1', date: '2026-11-19', quote: 'a quote nobody said' },
          ],
        }),
      },
      { sessionId: 'ses_c', verdicts: ['pass'] },
    ]).dream(repoArg(), opts());
    expect(out.outcome).toBe('nothing');
    expect(store.journal()[0]).toMatchObject({
      outcome: 'nothing',
      removedByCheck: 1,
    });
  });

  it('decides evidence before the cap of 3: proposals without a developer quote take no place', async () => {
    const unheard = (title: string, file: string) => ({
      ...proposal(title, file),
      evidence: [{ task: 't1', date: '2026-11-19', quote: 'nobody said this' }],
    });
    const out = await runner([
      {
        sessionId: 'ses_p',
        edits: {
          '.apm/rules/a.md': 'A\n',
          '.apm/rules/b.md': 'B\n',
          '.apm/rules/c.md': 'C\n',
          '.apm/rules/d.md': 'D\n',
        },
        report: report(
          unheard('Rule A', '.apm/rules/a.md'),
          unheard('Rule B', '.apm/rules/b.md'),
          unheard('Rule C', '.apm/rules/c.md'),
          proposal('Rule D', '.apm/rules/d.md'),
        ),
      },
      { sessionId: 'ses_c', verdicts: ['pass', 'pass', 'pass', 'pass'] },
    ]).dream(repoArg(), opts());
    if (out.outcome !== 'proposed') throw new Error(out.outcome);
    expect(out.result.proposals.map((p) => p.title)).toEqual(['Rule D']);
    expect(out.result.removedByCheck).toBe(3);
    expect(
      show(repo, 'show', '--name-only', '--format=', out.result.branch),
    ).toBe('.apm/rules/d.md');
  });

  it('never merges a proposal without a developer quote into a kept one that shares its file', async () => {
    const out = await runner([
      {
        sessionId: 'ses_p',
        edits: { '.apm/rules/a.md': 'A\n' },
        report: report(proposal('Rule A', '.apm/rules/a.md'), {
          ...proposal('Rule B', '.apm/rules/a.md'),
          evidence: [
            { task: 't1', date: '2026-11-19', quote: 'nobody said this' },
          ],
        }),
      },
      { sessionId: 'ses_c', verdicts: ['pass', 'pass'] },
    ]).dream(repoArg(), opts());
    if (out.outcome !== 'proposed') throw new Error(out.outcome);
    expect(out.result.proposals.map((p) => p.title)).toEqual(['Rule A']);
    expect(out.result.proposals[0].evidence.map((e) => e.quote)).toEqual([
      'use the helper',
    ]);
    expect(out.result.removedByCheck).toBe(1);
  });

  it('maps evidence to tasks by id, digest file or label, and keeps an unknown one as given', async () => {
    tasks = [task('t1'), { ...task('t2'), label: 'Fix the login page' }];
    const runs = twoProposals();
    const p = proposal('Rule A', '.apm/rules/a.md');
    p.evidence = ['tasks/t1.md', 'the login page', 'nope'].map((t) => ({
      task: t,
      date: '2026-11-19',
      quote: t === 'tasks/t1.md' ? 'use the helper' : 'q',
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

  it('never takes a number the journal already names for this repo (an earlier dream left no branch)', async () => {
    await store.log({
      dreamId: `${DATE}-1`,
      repoId: repoArg().id,
      at: new Date().toISOString(),
      model: 'x/y',
      tokens: 0,
      outcome: 'interrupted',
      reason: 'stopped',
      proposals: 0,
      removedByCheck: 0,
      closed: null,
    });
    const out = await runner(twoProposals()).dream(repoArg(), opts());
    expect(out.outcome === 'proposed' && out.result.id).toBe(`${DATE}-2`);
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

  it('refuses a second dream started in the same tick and leaves the first alone', async () => {
    const r = runner(twoProposals());
    const first = r.dream(repoArg(), opts());
    const second = r.dream(repoArg(), opts());
    expect(await second).toEqual({
      outcome: 'failed',
      reason: 'A dream is already running',
    });
    const out = await first;
    if (out.outcome !== 'proposed') throw new Error(out.outcome);
    expect(dreamBranches()).toEqual([out.result.branch]);
    expect(existsSync(out.result.worktreePath)).toBe(true);
    expect(store.journal()).toHaveLength(1);
    expect(store.repo('r1').failures).toBe(0);
  });

  it('fails without touching a dream branch someone else made meanwhile', async () => {
    class Racing extends GitClient {
      override async worktreeAdd(
        cwd: string,
        o: Parameters<GitClient['worktreeAdd']>[1],
      ): Promise<string> {
        git(cwd, 'branch', o.branch);
        return super.worktreeAdd(cwd, o);
      }
    }
    const out = await runner(twoProposals(), { git: new Racing() }).dream(
      repoArg(),
      opts(),
    );
    expect(out).toEqual({
      outcome: 'failed',
      reason: 'A dream of that name already exists',
    });
    expect(dreamBranches()).toEqual([`dream/${DATE}-1`]);
    expect(readdirSync(path.join(dreamsDir, 'r1'))).toEqual([]);
    expect(fake!.calls()).toHaveLength(0);
  });

  it('fails with a fixed reason when the target branch is not there', async () => {
    const out = await runner(twoProposals(), {
      baseBranch: async () => 'no-such-branch',
    }).dream(repoArg(), opts());
    expect(out).toEqual({
      outcome: 'failed',
      reason: 'the target branch was not found',
    });
    expectNothingLeft();
    expect(store.journal()).toMatchObject([
      { dreamId: `${DATE}-0`, outcome: 'failed' },
    ]);
  });

  it('runs no repo hook: not when adding the worktree, reverting or committing', async () => {
    const markers = ['post-checkout', 'pre-commit', 'post-commit'].map(
      (name) => {
        const marker = path.join(root, `${name}.ran`);
        const file = path.join(repo, '.git', 'hooks', name);
        writeFileSync(file, `#!/bin/sh\ntouch '${marker}'\n`);
        chmodSync(file, 0o755);
        return marker;
      },
    );
    const runs = twoProposals();
    runs[0].edits!['src/app.ts'] = 'changed\n';
    const out = await runner(runs).dream(repoArg(), opts());
    if (out.outcome !== 'proposed') throw new Error(out.outcome);
    expect(out.result.reverted).toEqual(['src/app.ts']);
    expect(markers.filter((m) => existsSync(m))).toEqual([]);
  });

  it('passes core.longpaths=true to every git call that works in the dream worktree or deletes its branch', async () => {
    const spy = vi.spyOn(GitClient.prototype, 'run');
    const runs = twoProposals();
    runs[0].edits!['src/app.ts'] = 'changed\n';
    const out = await runner(runs).dream(repoArg(), opts());
    expect(out.outcome).toBe('proposed');
    // And one that removes what it made: its branch is deleted with the same settings.
    tasks = [task('t2')];
    const nothing = await runner([
      {
        sessionId: 'ses_p',
        edits: { '.apm/rules/x.md': 'X\n' },
        report: report(),
      },
    ]).dream({ ...repoArg() }, opts());
    expect(nothing.outcome).toBe('nothing');
    const calls = spy.mock.calls.map(([cwd, args]) => ({ cwd, args }));
    const roots = [dreamsDir, realpathSync(dreamsDir)];
    const inDreams = calls.filter((c) =>
      roots.some((d) => !path.relative(d, c.cwd).startsWith('..')),
    );
    expect(inDreams.length).toBeGreaterThan(5);
    const unattended = calls.filter((c) =>
      c.args.some((a) => a.startsWith('core.hooksPath=')),
    );
    for (const c of [...inDreams, ...unattended])
      expect(c.args, c.args.join(' ')).toContain('core.longpaths=true');
    expect(
      unattended.some(
        (c) => c.args.includes('branch') && c.args.includes('-D'),
      ),
    ).toBe(true);
  });

  it('reverts a write to an ignored path like any other outside change', async () => {
    writeFileSync(path.join(repo, '.gitignore'), '*.log\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'ignore logs');
    git(repo, 'push', '-q', 'origin', 'main');
    const runs = twoProposals();
    runs[0].edits!['src/debug.log'] = 'secret\n';
    const out = await runner(runs).dream(repoArg(), opts());
    if (out.outcome !== 'proposed') throw new Error(out.outcome);
    expect(out.result.reverted).toEqual(['src/debug.log']);
    expect(
      existsSync(path.join(out.result.worktreePath, 'src/debug.log')),
    ).toBe(false);
  });

  it('bases the dream on the fetched target when origin is ahead', async () => {
    const other = path.join(root, 'other');
    git(root, 'clone', '-q', bare, 'other');
    git(other, 'config', 'user.email', 'o@x');
    git(other, 'config', 'user.name', 'O');
    writeFileSync(path.join(other, 'ahead.txt'), 'ahead\n');
    git(other, 'add', 'ahead.txt');
    git(other, 'commit', '-q', '-m', 'ahead');
    git(other, 'push', '-q', 'origin', 'main');
    const ahead = show(other, 'rev-parse', 'HEAD');
    const out = await runner(twoProposals()).dream(repoArg(), opts());
    if (out.outcome !== 'proposed') throw new Error(out.outcome);
    expect(out.result.baseSha).toBe(ahead);
    expect(show(repo, 'rev-parse', 'main')).not.toBe(ahead);
  });

  it('blanks an inherited OPENCODE_PERMISSION and gives the check run no edits in the worktree', async () => {
    vi.stubEnv('OPENCODE_PERMISSION', '{"*":"allow"}');
    try {
      const out = await runner(twoProposals()).dream(repoArg(), opts());
      expect(out.outcome).toBe('proposed');
    } finally {
      vi.unstubAllEnvs();
    }
    const [propose, check] = fake!.calls();
    expect(propose.env.OPENCODE_PERMISSION).toBe('');
    expect(check.env.OPENCODE_PERMISSION).toBe('');
    const edit = (c: typeof propose) =>
      JSON.parse(c.env.OPENCODE_CONFIG_CONTENT!).permission.edit as Record<
        string,
        string
      >;
    expect(edit(propose)['**']).toBe('allow');
    expect(edit(check)['**']).toBeUndefined();
  });

  it('writes the propose run’s changes to changes.diff in the data folder before the check run', async () => {
    let seen: string | null = null;
    let calls = 0;
    const r = runner(twoProposals(), {
      run: (cmd, o) => {
        calls += 1;
        if (calls === 2) {
          const file = path.join(path.dirname(o.cwd), 'data', 'changes.diff');
          seen = existsSync(file) ? readFileSync(file, 'utf8') : null;
        }
        return runWithInput(cmd, o);
      },
    });
    const out = await r.dream(repoArg(), opts());
    // Outside the worktree: the read-only backstop does not count it, and nothing of it is committed.
    expect(out.outcome).toBe('proposed');
    expect(seen).toContain('+++ b/.apm/rules/a.md');
    expect(seen).toContain('+A');
    expect(seen).toContain('+++ b/.apm/rules/b.md');
    expect(fake!.calls()[1].input).toContain('changes.diff');
  });

  it('fails with git could not read the changes when writing changes.diff times out, and removes everything', async () => {
    const real = GitClient.prototype.run;
    vi.spyOn(GitClient.prototype, 'run').mockImplementation(function (
      this: GitClient,
      cwd,
      args,
      o,
    ) {
      if (args.includes('read-tree'))
        return Promise.reject(new Error('git read-tree timed out'));
      return real.call(this, cwd, args, o);
    });
    const out = await runner(twoProposals()).dream(repoArg(), opts());
    expect(out).toEqual({
      outcome: 'failed',
      reason: 'git could not read the changes',
    });
    expect(fake!.calls()).toHaveLength(1);
    expectNothingLeft();
  });

  it('fails and removes everything when the check run changes a file', async () => {
    const runs = twoProposals();
    runs[1].edits = { '.apm/rules/a.md': 'rewritten by the check\n' };
    const out = await runner(runs).dream(repoArg(), opts());
    expect(out).toEqual({
      outcome: 'failed',
      reason: 'The check run changed files',
    });
    expectNothingLeft();
    expect(store.repo('r1').covered).toEqual({});
  });

  it('fails as a dream when the sessions cannot be read', async () => {
    const out = await runner(twoProposals(), {
      sessionsOf: async () => {
        throw new Error('/home/me/secret path');
      },
    }).dream(repoArg(), opts());
    expect(out).toEqual({
      outcome: 'failed',
      reason: 'The sessions could not be read',
    });
    expect(store.repo('r1').failures).toBe(1);
    expect(store.journal()).toMatchObject([
      {
        dreamId: `${DATE}-0`,
        outcome: 'failed',
        reason: 'The sessions could not be read',
      },
    ]);
    expect(existsSync(dreamsDir)).toBe(false);
  });

  it('keeps the journal entry and the marks when another store call fails', async () => {
    vi.spyOn(store, 'succeeded').mockRejectedValue(new Error('disk'));
    vi.spyOn(store, 'addSightings').mockRejectedValue(new Error('disk'));
    const out = await runner(twoProposals()).dream(repoArg(), opts());
    expect(out.outcome).toBe('proposed');
    expect(store.journal()).toMatchObject([{ outcome: 'proposed' }]);
    expect(store.repo('r1').covered).toEqual({ t1: NOW - 4000 });
  });

  it('removes the dream and stores no marks when its result cannot be stored', async () => {
    vi.spyOn(store, 'setResult').mockRejectedValue(new Error('disk'));
    const out = await runner(twoProposals()).dream(repoArg(), opts());
    expect(out).toEqual({
      outcome: 'failed',
      reason: 'The dream could not be saved',
    });
    expectNothingLeft();
    expect(store.repo('r1').covered).toEqual({});
    expect(store.journal()).toMatchObject([{ outcome: 'failed' }]);
  });

  /** A run that ignores its signal and settles only when told to. */
  function lateRun() {
    let settle: () => void = () => undefined;
    let started = false;
    const run = (() =>
      new Promise<string>((_, reject) => {
        started = true;
        settle = () => reject(new Error('killed late'));
      })) as DreamRunnerDeps['run'];
    return { run, started: () => started, settle: () => settle() };
  }

  it('waits for a stopped run to end before removing its folders', async () => {
    const late = lateRun();
    const r = runner([], { run: late.run });
    const ac = new AbortController();
    const done = r.dream(repoArg(), opts(ac.signal));
    await vi.waitFor(() => expect(late.started()).toBe(true));
    ac.abort();
    await new Promise((res) => setTimeout(res, 300));
    expect(readdirSync(path.join(dreamsDir, 'r1'))).toEqual([`${DATE}-1`]);
    late.settle();
    expect(await done).toEqual({ outcome: 'interrupted', why: 'stopped' });
    expectNothingLeft();
  });

  it('removes the folders after 10 s when a stopped run never ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const late = lateRun();
    const r = runner([], { run: late.run });
    const ac = new AbortController();
    const done = r.dream(repoArg(), opts(ac.signal));
    await vi.waitFor(() => expect(late.started()).toBe(true));
    ac.abort();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(readdirSync(path.join(dreamsDir, 'r1'))).toEqual([`${DATE}-1`]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toEqual({ outcome: 'interrupted', why: 'stopped' });
    expectNothingLeft();
  });
});
