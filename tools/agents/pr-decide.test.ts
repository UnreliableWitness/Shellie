import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.mjs';
import { decidePr, mainCiGreen, prBookkeeping } from './pr-decide.mjs';

const sha = 'h1';
const finding = {
  file: 'src/a.ts',
  line: 3,
  severity: 'important',
  problem: 'p',
  scenario: 's',
};
const input = (
  over: Record<string, unknown> = {},
  pr: Record<string, unknown> = {},
  prState: Record<string, unknown> = {},
) => ({
  pr: {
    number: 9,
    labels: [{ name: 'agent-pr' }, { name: 'kind:bug' }, { name: 'risk:low' }],
    mergeable_state: 'clean',
    head: { sha },
    ...pr,
  },
  prState: {
    v: 1,
    kind: 'pr',
    issue: 4,
    reviews: { [sha]: { verdict: 'approve', items: [] } },
    fixRounds: 0,
    lastSeenAt: '2026-10-26T10:00:00Z',
    ...prState,
  },
  checks: { state: 'green', failed: [] as string[] },
  mainGreen: true,
  mode: 'full',
  config: parseConfig(''),
  ownerApproved: false,
  trustedComments: [] as { id: number; author: string; body: string }[],
  paths: { denied: [] as string[], ownerOnly: [] as string[] },
  lines: 40,
  behindMain: false,
  ownerChangesRequested: false,
  now: new Date('2026-10-26T12:00:00Z'),
  ...over,
});
const labels = (...names: string[]) => names.map((name) => ({ name }));

describe('decidePr: waiting', () => {
  it('leaves a stopped PR alone', () => {
    expect(
      decidePr(input({}, { labels: labels('agent-pr', 'agent:stop') }) as never)
        .action,
    ).toBe('wait');
  });
  it('waits for CI, for GitHub to work out mergeability, and for the review of the head', () => {
    expect(
      decidePr(input({ checks: { state: 'pending', failed: [] } }) as never)
        .reason,
    ).toBe('ci-pending');
    expect(
      decidePr(input({}, { mergeable_state: 'unknown' }) as never).reason,
    ).toBe('mergeable-unknown');
    expect(decidePr(input({}, {}, { reviews: {} }) as never).reason).toBe(
      'review-pending',
    );
  });
});

describe('decidePr: fixing', () => {
  it('fixes red CI, review findings, trusted comments and conflicts, with the inputs', () => {
    const red = decidePr(
      input({
        checks: { state: 'red', failed: ['test (windows-latest)'] },
      }) as never,
    );
    expect(red).toMatchObject({
      action: 'fix',
      fixInput: { ciFailures: ['test (windows-latest)'], conflict: false },
    });
    const changes = decidePr(
      input(
        {},
        {},
        { reviews: { [sha]: { verdict: 'changes', items: [finding] } } },
      ) as never,
    );
    expect(changes).toMatchObject({
      action: 'fix',
      fixInput: { findings: [finding] },
    });
    const comment = decidePr(
      input({
        trustedComments: [
          {
            id: 11,
            at: '2026-10-26T11:00:00Z',
            author: 'UnreliableWitness',
            body: 'rename it',
          },
        ],
      }) as never,
    );
    expect(comment).toMatchObject({
      action: 'fix',
      fixInput: { comments: [{ id: 11 }] },
    });
    expect(
      decidePr(
        input({
          trustedComments: [
            {
              id: 99,
              at: '2026-10-26T09:00:00Z',
              author: 'UnreliableWitness',
              body: 'old',
            },
          ],
        }) as never,
      ).action,
    ).toBe('merge');
    const conflict = decidePr(
      input(
        { checks: { state: 'green', failed: [] } },
        { mergeable_state: 'dirty' },
      ) as never,
    );
    expect(conflict).toMatchObject({
      action: 'fix',
      fixInput: { conflict: true },
    });
  });
  it('fixes a conflict even when CI on the old head is not finished', () => {
    expect(
      decidePr(
        input(
          { checks: { state: 'pending', failed: [] } },
          { mergeable_state: 'dirty' },
        ) as never,
      ).action,
    ).toBe('fix');
  });
  it('gives up once after the last round', () => {
    const red = { checks: { state: 'red', failed: ['x'] } };
    expect(decidePr(input(red, {}, { fixRounds: 3 }) as never).action).toBe(
      'give-up',
    );
    expect(
      decidePr(input(red, {}, { fixRounds: 3, gaveUp: true }) as never).action,
    ).toBe('wait');
  });
});

describe('decidePr: merging', () => {
  it('updates a branch that is behind main first', () => {
    expect(
      decidePr(input({}, { mergeable_state: 'behind' }) as never).action,
    ).toBe('update-branch');
  });
  it('merges a green, approved, small low-risk bug fix in full mode only', () => {
    expect(decidePr(input() as never).action).toBe('merge');
    expect(decidePr(input({ mode: 'implement' }) as never)).toMatchObject({
      action: 'awaits-owner',
      reasons: ['implement mode: nothing merges by itself'],
    });
  });
  it('sends features, high risk, size, owner-only paths, a red main and hold-merge to the owner', () => {
    const reasons = (
      o: Record<string, unknown>,
      pr: Record<string, unknown> = {},
    ) => decidePr(input(o, pr) as never).reasons;
    expect(
      reasons({}, { labels: labels('agent-pr', 'kind:feature', 'risk:low') }),
    ).toContain('a feature');
    expect(
      reasons({}, { labels: labels('agent-pr', 'kind:bug', 'risk:high') }),
    ).toContain('high risk');
    expect(reasons({ lines: 401 })).toContain('401 changed lines');
    expect(
      reasons({ paths: { denied: [], ownerOnly: ['package.json'] } }),
    ).toContain('touches package.json');
    expect(reasons({ mainGreen: false })).toContain('main is red');
    expect(
      reasons(
        {},
        {
          labels: labels(
            'agent-pr',
            'kind:bug',
            'risk:low',
            'agent:hold-merge',
          ),
        },
      ),
    ).toContain('agent:hold-merge');
  });
  it('merges a feature the owner approved, but never past a red main or hold-merge', () => {
    const feature = { labels: labels('agent-pr', 'kind:feature', 'risk:high') };
    expect(
      decidePr(input({ ownerApproved: true }, feature) as never).action,
    ).toBe('merge');
    expect(
      decidePr(
        input({ ownerApproved: true, mainGreen: false }, feature) as never,
      ).action,
    ).toBe('awaits-owner');
  });
  it('tells the owner only once per head commit', () => {
    expect(
      decidePr(
        input({ mode: 'implement' }, {}, { awaitsOwnerSha: sha }) as never,
      ).action,
    ).toBe('wait');
  });
  it('a review that failed goes to the owner', () => {
    expect(
      decidePr(
        input({}, {}, { reviews: { [sha]: { verdict: 'error' } } }) as never,
      ).reasons,
    ).toContain('the agent review failed');
  });
});

describe('prBookkeeping', () => {
  it('tells merged from closed', () => {
    expect(
      prBookkeeping({
        state: 'closed',
        merged_at: '2026-10-26T10:00:00Z',
        merge_commit_sha: 'm',
      }),
    ).toEqual({
      outcome: 'merged',
      mergeSha: 'm',
      mergedAt: '2026-10-26T10:00:00Z',
    });
    expect(prBookkeeping({ state: 'closed', merged_at: null })).toEqual({
      outcome: 'closed',
    });
    expect(prBookkeeping({ state: 'open', merged_at: null })).toBeNull();
  });
});

describe('decidePr: review fixes', () => {
  it('updates a branch that is behind main only when it could otherwise merge', () => {
    expect(decidePr(input({ behindMain: true }) as never).action).toBe(
      'update-branch',
    );
    const feature = { labels: labels('agent-pr', 'kind:feature', 'risk:low') };
    expect(decidePr(input({ behindMain: true }, feature) as never).action).toBe(
      'awaits-owner',
    );
  });
  it("never merges past the owner's Request changes", () => {
    expect(
      decidePr(input({ ownerChangesRequested: true }) as never).reasons,
    ).toContain('the owner requested changes');
    expect(
      decidePr(
        input({ ownerChangesRequested: true, ownerApproved: true }) as never,
      ).action,
    ).toBe('awaits-owner');
  });
  it('waits an hour before retrying a fix that changed nothing', () => {
    const red = { checks: { state: 'red', failed: ['x'] } };
    expect(
      decidePr(
        input(
          red,
          {},
          { fixRounds: 1, lastFixSha: sha, lastFixAt: '2026-10-26T11:30:00Z' },
        ) as never,
      ).reason,
    ).toBe('fix-retry-later');
    expect(
      decidePr(
        input(
          red,
          {},
          { fixRounds: 1, lastFixSha: sha, lastFixAt: '2026-10-26T10:30:00Z' },
        ) as never,
      ).action,
    ).toBe('fix');
    expect(
      decidePr(
        input(
          red,
          {},
          {
            fixRounds: 1,
            lastFixSha: 'old',
            lastFixAt: '2026-10-26T11:30:00Z',
          },
        ) as never,
      ).action,
    ).toBe('fix');
  });
  it('asks the owner when the review wants changes but gave no findings', () => {
    expect(
      decidePr(
        input({}, {}, { reviews: { [sha]: { verdict: 'changes' } } }) as never,
      ).reasons,
    ).toContain('the agent review wants changes but listed no findings to fix');
  });
});

describe('mainCiGreen', () => {
  it('reads the newest finished run that was not cancelled, and waits while one runs', () => {
    const run = (status: string, conclusion: string | null) => ({
      status,
      conclusion,
    });
    expect(mainCiGreen([run('completed', 'success')])).toBe(true);
    expect(
      mainCiGreen([run('in_progress', null), run('completed', 'success')]),
    ).toBe(false);
    expect(
      mainCiGreen([run('completed', 'cancelled'), run('completed', 'success')]),
    ).toBe(true);
    expect(mainCiGreen([run('completed', 'failure')])).toBe(false);
    expect(mainCiGreen([])).toBe(false);
  });
});
