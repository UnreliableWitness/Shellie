import { describe, expect, it } from 'vitest';
import { parseConfig, parseTrusted } from './config.mjs';
import { runReview } from './review.mjs';
import { parseStatus, renderStatus } from './state.mjs';

const bot = 'shellie-agents[bot]';
const now = new Date('2026-10-26T12:00:00Z');
const spec = { problem: 'p', cause: 'c', change: 'ch', test: 't' };
const answer = (findings: unknown[] = [], risk = 'low') => ({
  ok: true,
  tokens: 900,
  limited: false,
  output: { summary: 'ok', risk, findings },
});

function fake() {
  let nextId = 2000;
  const writes: string[] = [];
  const issue = {
    number: 4,
    title: 'Breaks',
    body: 'b',
    user: { login: 'maximedebraekeleer' },
    labels: [{ name: 'agent:pr-open' }, { name: 'risk:low' }],
    comments: 1,
  };
  const pr = {
    number: 9,
    title: 'Fix (#4)',
    body: 'What changed\n\nFixes #4',
    user: { login: bot },
    head: { sha: 'sha1', ref: 'agent/issues/4-breaks' },
    labels: [{ name: 'agent-pr' }, { name: 'risk:low' }],
  };
  const human = {
    number: 10,
    title: 'Mine',
    body: '',
    user: { login: 'UnreliableWitness' },
    head: { sha: 'h', ref: 'x' },
    labels: [{ name: 'agent-pr' }],
  };
  const comments: Record<
    number,
    { id: number; user: { login: string }; body: string; created_at: string }[]
  > = {
    4: [
      {
        id: 1,
        user: { login: bot },
        body: renderStatus(
          {
            v: 1,
            state: 'pr-open',
            spec,
            pr: 9,
            lastSeenCommentId: 0,
            triageRounds: 1,
            tokens: 0,
          },
          'x',
        ),
        created_at: '',
      },
    ],
  };
  const reviews: unknown[] = [];
  const all = [issue, pr, human] as {
    number: number;
    labels: { name: string }[];
  }[];
  const gh = {
    writes,
    reviews,
    pr,
    issue,
    comments,
    failInline: false,
    async listOpenIssues() {
      return [issue];
    },
    async listOpenPulls() {
      return [pr, human];
    },
    async listComments(n: number) {
      return comments[n] ?? [];
    },
    async comment(n: number, body: string) {
      writes.push(`comment #${n}`);
      const c = { id: nextId++, user: { login: bot }, body, created_at: '' };
      (comments[n] ??= []).push(c);
      return c;
    },
    async editComment(id: number, body: string) {
      for (const l of Object.values(comments))
        for (const c of l) if (c.id === id) c.body = body;
    },
    async addLabels(n: number, labels: string[]) {
      writes.push(`label #${n} +${labels.join(',')}`);
      const i = all.find((x) => x.number === n)!;
      for (const name of labels) i.labels.push({ name });
    },
    async removeLabel(n: number, label: string) {
      writes.push(`label #${n} -${label}`);
      const i = all.find((x) => x.number === n)!;
      i.labels = i.labels.filter((l) => l.name !== label);
    },
    async findIssueByLabel() {
      return { number: 900, body: '' };
    },
    async createIssue() {
      return { number: 900, body: '' };
    },
    async editIssueBody() {},
    async listPullFiles() {
      return ['src/a.ts'];
    },
    async createReview(n: number, payload: { comments?: unknown[] }) {
      if (gh.failInline && payload.comments?.length)
        throw new Error(
          'gh POST pulls/9/reviews: HTTP 422 Unprocessable Entity (line must be part of the diff)',
        );
      reviews.push({ n, payload });
      writes.push(`review #${n}`);
    },
  };
  return gh;
}
const fakeGit = () => {
  const made: number[] = [];
  return {
    made,
    git: {
      worktree: async (n: number) => {
        made.push(n);
        return `/tmp/pr-${n}`;
      },
      removeWorktree: async () => {},
    },
  };
};
function opts(
  gh: ReturnType<typeof fake>,
  results: unknown[],
  over: Record<string, unknown> = {},
) {
  const prompts: string[] = [];
  const { git, made } = fakeGit();
  return {
    prompts,
    made,
    o: {
      gh,
      git,
      runAgent: async (prompt: string) => {
        prompts.push(prompt);
        return results.shift() ?? answer();
      },
      config: parseConfig(''),
      trusted: parseTrusted(
        'owner: UnreliableWitness\nlogins: [maximedebraekeleer]',
      ),
      mode: 'implement',
      now,
      summary: () => {},
      ...over,
    },
  };
}
const prStatus = (gh: ReturnType<typeof fake>) =>
  parseStatus(gh.comments[9].find((c) => parseStatus(c.body))!.body);

describe('runReview', () => {
  it('stays off outside implement and full', async () => {
    const gh = fake();
    const d = opts(gh, [], { mode: 'triage' });
    await runReview(d.o as never);
    expect(d.prompts).toEqual([]);
  });

  it('reviews only bot-authored agent PRs, once per head commit', async () => {
    const gh = fake();
    const d = opts(gh, [
      answer([
        {
          file: 'src/a.ts',
          line: 2,
          severity: 'important',
          problem: 'x',
          scenario: 'y',
        },
      ]),
    ]);
    await runReview(d.o as never);
    expect(d.prompts).toHaveLength(1);
    expect(d.made).toEqual([9]);
    expect(gh.writes).toContain('review #9');
    expect(prStatus(gh)).toMatchObject({
      kind: 'pr',
      issue: 4,
      reviews: { sha1: { verdict: 'changes', findings: 1 } },
    });
    await runReview(d.o as never);
    expect(d.prompts).toHaveLength(1);
    gh.pr.head.sha = 'sha2';
    await runReview(d.o as never);
    expect(d.prompts).toHaveLength(2);
  });

  it('retries without inline comments when GitHub refuses a line', async () => {
    const gh = fake();
    gh.failInline = true;
    const d = opts(gh, [
      answer([
        {
          file: 'src/a.ts',
          line: 999,
          severity: 'important',
          problem: 'x',
          scenario: 'y',
        },
      ]),
    ]);
    await runReview(d.o as never);
    expect(gh.reviews).toHaveLength(1);
    expect(
      (gh.reviews[0] as { payload: { body: string } }).payload.body,
    ).toContain('src/a.ts:999');
  });

  it('raises the risk on the PR and the issue', async () => {
    const gh = fake();
    const d = opts(gh, [answer([], 'high')]);
    await runReview(d.o as never);
    expect(gh.writes).toEqual(
      expect.arrayContaining([
        'label #9 +risk:high',
        'label #9 -risk:low',
        'label #4 +risk:high',
        'label #4 -risk:low',
      ]),
    );
  });

  it('passes the triage spec and the changed files to the agent', async () => {
    const gh = fake();
    const d = opts(gh, [answer()]);
    await runReview(d.o as never);
    expect(d.prompts[0]).toContain('Problem: p');
    expect(d.prompts[0]).toContain('src/a.ts');
  });

  it('skips a PR it cannot tie to an issue', async () => {
    const gh = fake();
    gh.pr.body = 'no link';
    const d = opts(gh, [answer()]);
    await runReview(d.o as never);
    expect(d.prompts).toEqual([]);
  });

  it('records a failed post and does not run again within the hour', async () => {
    const gh = fake();
    gh.createReview = async () => {
      throw new Error(
        'gh POST repos/o/r/pulls/9/reviews: HTTP 403 Resource not accessible',
      );
    };
    const d = opts(gh, [answer(), answer()]);
    await runReview(d.o as never);
    await runReview(d.o as never);
    expect(d.prompts).toHaveLength(1);
  });

  it('gives up on a head commit after two failed reviews', async () => {
    const gh = fake();
    const bad = {
      ok: true,
      tokens: 1,
      limited: false,
      output: { nonsense: true },
    };
    const d = opts(gh, [bad, bad, bad]);
    await runReview(d.o as never);
    await runReview({
      ...d.o,
      now: new Date(now.getTime() + 2 * 3600000),
    } as never);
    await runReview({
      ...d.o,
      now: new Date(now.getTime() + 4 * 3600000),
    } as never);
    expect(d.prompts).toHaveLength(2);
    expect(prStatus(gh).reviews.sha1.verdict).toBe('error');
  });

  it("finds the issue from the PR's status block, else the last Fixes line", async () => {
    const gh = fake();
    gh.pr.body = 'The agent wrote Fixes #42 in its text\n\nFixes #4';
    const d = opts(gh, [answer()]);
    await runReview(d.o as never);
    expect(d.prompts[0]).toMatch(/fix issue #4\b/);
  });

  it('treats only HTTP 422 as a refused line', async () => {
    const gh = fake();
    gh.pr.number = 4220;
    let calls = 0;
    gh.createReview = async () => {
      calls++;
      throw new Error('gh POST repos/o/r/pulls/4220/reviews: HTTP 500');
    };
    const d = opts(gh, [
      answer([
        {
          file: 'src/a.ts',
          line: 2,
          severity: 'minor',
          problem: 'x',
          scenario: 'y',
        },
      ]),
    ]);
    await runReview(d.o as never);
    expect(calls).toBe(1);
  });
});
