import { describe, expect, it } from 'vitest';
import type {
  RawPolicyEvaluation,
  RawPrDetail,
  RawPrStatus,
  RawPrThread,
} from '../services/AdoClient';
import { pickPr, toPrPulse } from './prPulse';

const pr = (o: Partial<RawPrDetail> = {}): RawPrDetail => ({
  pullRequestId: 1,
  status: 'active',
  isDraft: false,
  creationDate: '2026-11-10T00:00:00Z',
  closedDate: null,
  mergeStatus: null,
  projectId: 'p',
  createdById: 'me',
  webUrl: 'https://x/pr/1',
  reviewers: [],
  ...o,
});
const ev = (o: Partial<RawPolicyEvaluation>): RawPolicyEvaluation => ({
  status: 'approved',
  typeName: 'Build',
  displayName: 'CI',
  minimumApproverCount: null,
  ...o,
});
const st = (o: Partial<RawPrStatus>): RawPrStatus => ({
  state: 'succeeded',
  context: 'c',
  description: null,
  creationDate: '2026-11-10T00:00:00Z',
  ...o,
});
const now = new Date('2026-11-18T12:00:00Z');
const run = (
  o: {
    pr?: RawPrDetail | null;
    evaluations?: RawPolicyEvaluation[];
    statuses?: RawPrStatus[];
    threads?: RawPrThread[];
  } = {},
) =>
  toPrPulse({
    workspaceId: 'w',
    pr: pr(),
    evaluations: [],
    statuses: [],
    threads: [],
    me: 'me',
    now,
    ...o,
  });

describe('pickPr', () => {
  it('prefers an active PR over a newer completed one', () => {
    const a = pr({ pullRequestId: 1, status: 'active' });
    const c = pr({ pullRequestId: 2, status: 'completed' });
    expect(pickPr([c, a], null)).toBe(a);
  });
  it('ignores a PR closed before the task was opened', () => {
    const c = pr({ status: 'completed', closedDate: '2026-11-01T00:00:00Z' });
    expect(pickPr([c], '2026-11-05T00:00:00Z')).toBeNull();
    expect(pickPr([c], null)).toBe(c);
  });
  it('keeps abandoned PRs and the newest completed one', () => {
    const ab = pr({ status: 'abandoned', closedDate: '2026-11-09T00:00:00Z' });
    expect(pickPr([ab], '2026-11-05T00:00:00Z')).toBe(ab);
    const c2 = pr({
      pullRequestId: 2,
      status: 'completed',
      closedDate: '2026-11-08T00:00:00Z',
    });
    const c3 = pr({
      pullRequestId: 3,
      status: 'completed',
      closedDate: '2026-11-09T00:00:00Z',
    });
    expect(pickPr([c3, c2], null)).toBe(c3);
  });
});

describe('toPrPulse', () => {
  it('has an empty pulse without a PR', () => {
    expect(run({ pr: null })).toEqual({
      workspaceId: 'w',
      pr: null,
      ci: 'none',
      ciFailedName: null,
      review: 'none',
      approvals: { have: 0, need: null },
      conflict: false,
      unanswered: 0,
      checkedAt: now.toISOString(),
    });
  });
  it('maps the PR fields', () => {
    expect(run({ pr: pr({ closedDate: '2026-11-11T00:00:00Z' }) }).pr).toEqual({
      id: 1,
      url: 'https://x/pr/1',
      status: 'active',
      isDraft: false,
      createdAt: '2026-11-10T00:00:00Z',
      closedAt: '2026-11-11T00:00:00Z',
    });
  });
  it('reads CI from build evaluations', () => {
    expect(
      run({
        evaluations: [ev({ status: 'rejected', displayName: 'Build X' })],
      }),
    ).toMatchObject({ ci: 'failing', ciFailedName: 'Build X' });
    expect(run({ evaluations: [ev({ status: 'queued' })] }).ci).toBe('running');
    expect(run({ evaluations: [ev({ status: 'running' })] }).ci).toBe(
      'running',
    );
    expect(run({ evaluations: [ev({})] }).ci).toBe('passing');
    expect(run().ci).toBe('none');
  });
  it('reads CI from the latest status per context', () => {
    const failed = run({
      statuses: [
        st({
          context: 'a',
          state: 'failed',
          creationDate: '2026-11-11T00:00:00Z',
        }),
        st({
          context: 'a',
          state: 'succeeded',
          creationDate: '2026-11-10T00:00:00Z',
        }),
      ],
    });
    expect(failed).toMatchObject({ ci: 'failing', ciFailedName: 'a' });
    const fixed = run({
      statuses: [
        st({
          context: 'a',
          state: 'failed',
          creationDate: '2026-11-10T00:00:00Z',
        }),
        st({
          context: 'a',
          state: 'succeeded',
          creationDate: '2026-11-11T00:00:00Z',
        }),
      ],
    });
    expect(fixed.ci).toBe('passing');
    expect(run({ statuses: [st({ state: 'pending' })] }).ci).toBe('running');
    expect(run({ statuses: [st({ state: 'error', context: 'e' })] }).ci).toBe(
      'failing',
    );
  });
  it('ranks failing over running over passing', () => {
    expect(
      run({
        evaluations: [
          ev({}),
          ev({ status: 'running' }),
          ev({ status: 'rejected', displayName: 'Z' }),
        ],
      }),
    ).toMatchObject({ ci: 'failing', ciFailedName: 'Z' });
    expect(run({ evaluations: [ev({}), ev({ status: 'running' })] }).ci).toBe(
      'running',
    );
  });
  it('reads review state and approvals', () => {
    const rv = (vote: number, id = 'u', isContainer = false) => ({
      id,
      vote,
      isContainer,
    });
    const need2 = [
      ev({ typeName: 'Minimum number of reviewers', minimumApproverCount: 2 }),
    ];
    expect(run({ pr: pr({ reviewers: [rv(-10), rv(10, 'v')] }) }).review).toBe(
      'changes-asked',
    );
    const one = run({ pr: pr({ reviewers: [rv(10)] }), evaluations: need2 });
    expect(one).toMatchObject({
      review: 'waiting',
      approvals: { have: 1, need: 2 },
    });
    const two = run({
      pr: pr({ reviewers: [rv(10), rv(5, 'v'), rv(10, 'g', true)] }),
      evaluations: need2,
    });
    expect(two).toMatchObject({
      review: 'approved',
      approvals: { have: 2, need: 2 },
    });
    expect(run({ pr: pr({ reviewers: [rv(5)] }) })).toMatchObject({
      review: 'approved',
      approvals: { have: 1, need: null },
    });
    expect(run({ pr: pr({ reviewers: [rv(0)] }) }).review).toBe('waiting');
  });
  it('flags conflicts', () => {
    expect(run({ pr: pr({ mergeStatus: 'conflicts' }) }).conflict).toBe(true);
    expect(run({ pr: pr({ mergeStatus: 'succeeded' }) }).conflict).toBe(false);
  });
  it('counts unanswered threads', () => {
    const c = (authorId: string, commentType = 'text', isDeleted = false) => ({
      authorId,
      commentType,
      isDeleted,
    });
    const t = (
      comments: ReturnType<typeof c>[],
      status: string | null = 'active',
      isDeleted = false,
    ): RawPrThread => ({ status, isDeleted, comments });
    const threads = [
      t([c('rev')]), // counts
      t([c('rev'), c('me')]), // I answered
      t([c('rev'), c('me'), c('sys', 'system')]), // system after my reply
      t([c('sys', 'system')]), // only system
      t([c('me')]), // mine
      t([c('rev')], 'closed'), // resolved
      t([c('rev')], 'active', true), // deleted thread
      t([c('me'), c('rev', 'text', true)]), // deleted last comment ignored
      t([c('rev'), c('me', 'text', true)]), // my deleted reply ignored, rev counts
    ];
    expect(run({ threads }).unanswered).toBe(2);
  });
  it('ignores the PR author as the last commenter', () => {
    const t: RawPrThread = {
      status: 'active',
      isDeleted: false,
      comments: [{ authorId: 'author', commentType: 'text', isDeleted: false }],
    };
    expect(
      run({ pr: pr({ createdById: 'author' }), threads: [t] }).unanswered,
    ).toBe(0);
  });
});
