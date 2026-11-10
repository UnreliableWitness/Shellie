import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.mjs';
import { runNightly } from './nightly.mjs';
import {
  appIdFrom,
  collectTelemetry,
  QUERIES,
  toRows,
} from './nightly-telemetry.mjs';
import { parseStatus, renderStatus } from './state.mjs';

const bot = 'shellie-agents[bot]';
const now = new Date('2026-11-11T03:30:00Z');

type Issue = {
  number: number;
  title: string;
  body: string;
  state: string;
  user: { login: string };
  labels: { name: string }[];
  closed_at?: string | null;
};

function fakeGitHub(issues: Issue[] = []) {
  let nextId = 500;
  const writes: string[] = [];
  const comments: Record<
    number,
    { id: number; user: { login: string }; body: string }[]
  > = {};
  const all = [...issues];
  const gh = {
    writes,
    issues: all,
    comments,
    labels: [] as string[],
    async listLabels() {
      return gh.labels;
    },
    async createLabel(l: { name: string }) {
      gh.labels.push(l.name);
    },
    async listIssuesByLabel(label: string) {
      return all.filter((i) => i.labels.some((l) => l.name === label));
    },
    async findIssueByLabel(label: string) {
      return all.find((i) => i.labels.some((l) => l.name === label)) ?? null;
    },
    async createIssue(title: string, body: string, labels: string[]) {
      const i = {
        number: nextId++,
        title,
        body,
        state: 'open',
        user: { login: bot },
        labels: labels.map((name) => ({ name })),
      };
      all.push(i);
      if (!labels.includes('agent:activity'))
        writes.push(`issue ${title} +${labels.join(',')}`);
      return i;
    },
    async listComments(n: number) {
      return comments[n] ?? [];
    },
    async comment(n: number, body: string) {
      const c = { id: nextId++, user: { login: bot }, body };
      (comments[n] ??= []).push(c);
      return c;
    },
    async editComment(id: number, body: string) {
      for (const list of Object.values(comments))
        for (const c of list) if (c.id === id) c.body = body;
    },
  };
  return gh;
}

const finding = (signature: string) => ({
  signature,
  title: `Problem ${signature}`,
  problem: 'p',
  evidence: 'e',
  cause: 'c',
  suggestion: 's',
});
const answer = (...signatures: string[]) => ({
  ok: true,
  limited: false,
  tokens: 1000,
  output: { summary: 'looked', issues: signatures.map(finding) },
});
const telemetry = {
  generatedAt: now.toISOString(),
  window: 'w',
  queries: [{ name: 'exceptions', about: 'a', rows: [{ sig: 'x' }] }],
};

function fakeGit(over: Record<string, unknown> = {}) {
  return {
    head: async () => 'h'.repeat(40),
    hasCommit: async () => true,
    commitBefore: async () => 'b'.repeat(40),
    changedFiles: async () => ['src/main/a.ts'],
    log: async () => [{ sha: 'c'.repeat(40), subject: 'Change (#1)' }],
    ...over,
  };
}

function deps(
  gh: ReturnType<typeof fakeGitHub>,
  {
    health = [answer('stall:main-loop')] as unknown[],
    simplify = [answer('simplify:src/main/a.ts:reuse')] as unknown[],
    ...extra
  }: Record<string, any> = {},
) {
  const lines: string[] = [];
  const prompts: { source: string; prompt: string }[] = [];
  const agent =
    (source: string, results: unknown[]) => async (prompt: string) => {
      prompts.push({ source, prompt });
      return results.shift() ?? answer();
    };
  return {
    lines,
    prompts,
    opts: {
      gh,
      runAgent: {
        health: agent('health', health),
        simplify: agent('simplify', simplify),
      },
      git: fakeGit(),
      telemetry,
      config: parseConfig(''),
      mode: 'full',
      nightlyMode: 'live',
      now,
      summary: (l: string) => lines.push(l),
      ...extra,
    },
  };
}

const activityOf = (gh: ReturnType<typeof fakeGitHub>) => {
  const n = gh.issues.find((i) =>
    i.labels.some((l) => l.name === 'agent:activity'),
  )!.number;
  return parseStatus(gh.comments[n].at(-1)!.body);
};

describe('runNightly', () => {
  it('does nothing when the agents or the nightly agent are off', async () => {
    for (const [mode, nightlyMode] of [
      ['off', 'live'],
      ['', 'live'],
      ['full', 'off'],
    ]) {
      const gh = fakeGitHub();
      const d = deps(gh, { mode, nightlyMode });
      await runNightly(d.opts as any);
      expect(d.prompts).toEqual([]);
      expect(gh.issues).toEqual([]);
    }
  });

  it('shadow by default: both agents run, nothing is filed, the would-be issues are in the summary', async () => {
    const gh = fakeGitHub();
    const d = deps(gh, { nightlyMode: undefined });
    await runNightly(d.opts as any);
    expect(d.prompts.map((p) => p.source)).toEqual(['health', 'simplify']);
    expect(gh.writes).toEqual([]);
    expect(d.lines.join('\n')).toContain(
      'would open "Problem stall:main-loop"',
    );
    expect(activityOf(gh)).toMatchObject({
      poller: 'nightly',
      lastMainSha: 'h'.repeat(40),
      runsByDay: { '2026-11-11': 2 },
    });
  });

  it('AGENTS_MODE=shadow keeps it in shadow even when the nightly mode is live', async () => {
    const gh = fakeGitHub();
    const d = deps(gh, { mode: 'shadow' });
    await runNightly(d.opts as any);
    expect(gh.writes).toEqual([]);
  });

  it('live: files each pass with its source label, the simplify range from the last night', async () => {
    const gh = fakeGitHub();
    const d = deps(gh, {
      git: fakeGit({ commitBefore: async () => 'b'.repeat(40) }),
    });
    await runNightly(d.opts as any);
    expect(gh.writes).toEqual([
      'issue Problem stall:main-loop +source:health',
      'issue Problem simplify:src/main/a.ts:reuse +source:simplify',
    ]);
    expect(gh.labels).toContain('source:simplify');
    expect(d.prompts[1].prompt).toContain(
      `${'b'.repeat(40)}..${'h'.repeat(40)}`,
    );

    // the next night starts where this one ended, and does not file the open signatures again
    const d2 = deps(gh, {
      git: fakeGit({ head: async () => 'n'.repeat(40) }),
      now: new Date('2026-11-12T03:30:00Z'),
    });
    await runNightly(d2.opts as any);
    expect(d2.prompts[1].prompt).toContain(
      `${'h'.repeat(40)}..${'n'.repeat(40)}`,
    );
    expect(d2.prompts[0].prompt).toContain('stall:main-loop');
    expect(gh.writes).toHaveLength(2);
    expect(d2.lines.join('\n')).toMatch(
      /not filed `stall:main-loop` \(open as #\d+\)/,
    );
  });

  it('a closed signature is filed again as back after the fix', async () => {
    const closed: Issue = {
      number: 180,
      title: 'Unknown terminal',
      state: 'closed',
      closed_at: '2026-11-01T00:00:00Z',
      user: { login: bot },
      labels: [{ name: 'source:health' }],
      body: renderStatus(
        { v: 1, source: 'health', signature: 'stall:main-loop' },
        'x',
      ),
    };
    const gh = fakeGitHub([closed]);
    const d = deps(gh, { simplify: [answer()] });
    await runNightly(d.opts as any);
    const opened = gh.issues.find(
      (i) =>
        i.number !== 180 && i.labels.some((l) => l.name === 'source:health'),
    )!;
    expect(opened.body).toContain('Seen again after #180 was closed');
  });

  it('without telemetry the health pass is skipped and simplify still runs', async () => {
    const gh = fakeGitHub();
    const d = deps(gh, { telemetry: null, telemetryNote: 'no login' });
    await runNightly(d.opts as any);
    expect(d.prompts.map((p) => p.source)).toEqual(['simplify']);
    expect(d.lines).toContain('health: skipped (no login).');
  });

  it('no app code merged: no simplify run, and the range moves on', async () => {
    const gh = fakeGitHub();
    const d = deps(gh, { git: fakeGit({ changedFiles: async () => [] }) });
    await runNightly(d.opts as any);
    expect(d.prompts.map((p) => p.source)).toEqual(['health']);
    expect(activityOf(gh).lastMainSha).toBe('h'.repeat(40));
  });

  it('a usage limit pauses every agent and stops the second pass', async () => {
    const gh = fakeGitHub();
    const d = deps(gh, { health: [{ ok: false, limited: true, tokens: 0 }] });
    await runNightly(d.opts as any);
    expect(d.prompts.map((p) => p.source)).toEqual(['health']);
    const a = activityOf(gh);
    expect(a.pausedUntil).toBe('2026-11-11T04:30:00.000Z');
    expect(a.lastMainSha).toBeUndefined();
  });

  it('an invalid or failed simplify answer files nothing and keeps its range for the next night', async () => {
    const gh = fakeGitHub();
    const d = deps(gh, {
      simplify: [
        {
          ok: true,
          limited: false,
          tokens: 5,
          output: { summary: 's', issues: [{ title: 'x' }] },
        },
      ],
    });
    await runNightly(d.opts as any);
    expect(gh.writes).toEqual(['issue Problem stall:main-loop +source:health']);
    expect(d.lines.join('\n')).toContain('simplify: invalid answer');
    expect(activityOf(gh).lastMainSha).toBeUndefined();
  });

  it('respects the shared daily cap', async () => {
    const gh = fakeGitHub();
    const config = { ...parseConfig(''), maxAgentRunsPerDay: 1 };
    const d = deps(gh, { config });
    await runNightly(d.opts as any);
    expect(d.prompts.map((p) => p.source)).toEqual(['health']);
    expect(d.lines).toContain('simplify: no run (daily-cap).');
  });
});

describe('nightly telemetry', () => {
  it('reads the app id from the connection string', () => {
    expect(
      appIdFrom(
        'InstrumentationKey=x;IngestionEndpoint=https://e/;ApplicationId=ae2dd48f-a88b-48ef-89a4-21e9f87770b1',
      ),
    ).toBe('ae2dd48f-a88b-48ef-89a4-21e9f87770b1');
    expect(appIdFrom(undefined)).toBeUndefined();
  });
  it('turns a result table into rows: numbers rounded, dynamic columns parsed', () => {
    expect(
      toRows({
        tables: [
          {
            columns: [
              { name: 'op', type: 'string' },
              { name: 'mean', type: 'real' },
              { name: 'versions', type: 'dynamic' },
            ],
            rows: [['diff', 909.6, '["1.90.0"]']],
          },
        ],
      }),
    ).toEqual([{ op: 'diff', mean: 910, versions: ['1.90.0'] }]);
  });
  it('a failing query is reported in place and the others still run', async () => {
    const seen: string[] = [];
    const result = await collectTelemetry({
      now,
      query: async (kql) => {
        seen.push(kql);
        if (kql.includes('app.health')) throw new Error('HTTP 400');
        return {
          tables: [{ columns: [{ name: 'n', type: 'long' }], rows: [[1]] }],
        };
      },
    });
    expect(seen).toHaveLength(QUERIES.length);
    expect(seen.every((k) => k.startsWith('let recent = ago(1d);'))).toBe(true);
    expect(result.queries.find((q) => q.name === 'stalls')).toMatchObject({
      error: 'HTTP 400',
    });
    expect(result.queries.find((q) => q.name === 'overview')).toMatchObject({
      rows: [{ n: 1 }],
    });
  });
});
