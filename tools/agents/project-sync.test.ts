import { describe, expect, it } from 'vitest';
import { planSync, readyRank } from './project-sync.mjs';

const issueCard = (
  itemId: string,
  number: number,
  labels: string[],
  column: string | null,
  state = 'OPEN',
) => ({
  itemId,
  column,
  content: {
    type: 'Issue',
    number,
    state,
    labels,
    repo: 'UnreliableWitness/Shellie',
  },
});
const repoIssue = (
  number: number,
  labels: string[] = [],
  id = `I_${number}`,
) => ({ id, number, labels, state: 'OPEN' });

describe('planSync', () => {
  it('turns a draft card into an issue and adds open issues that are not on the board', () => {
    const board = [
      {
        itemId: 'D1',
        column: 'Inbox',
        content: { type: 'DraftIssue', title: 'Idea' },
      },
      issueCard('C1', 1, [], 'Inbox'),
    ];
    const plan = planSync({
      board,
      issues: [repoIssue(1), repoIssue(2)],
      waitsForOwner: new Set(),
      skip: new Set(),
    });
    expect(plan).toEqual(
      expect.arrayContaining([
        { type: 'convert', itemId: 'D1' },
        { type: 'add', issueId: 'I_2', number: 2 },
      ]),
    );
  });
  it('moves a card to the column its labels say, and leaves a card that is right alone', () => {
    const board = [
      issueCard('C1', 1, ['agent:ready'], 'Inbox'),
      issueCard('C2', 2, ['agent:needs-info'], 'Needs info'),
    ];
    expect(
      planSync({
        board,
        issues: [],
        waitsForOwner: new Set(),
        skip: new Set(),
      }),
    ).toEqual([{ type: 'move', itemId: 'C1', number: 1, column: 'Ready' }]);
  });
  it('shows an issue whose agent PR waits for the owner as Waiting for you', () => {
    const board = [
      issueCard('C1', 1, ['agent:pr-open', 'claude-working'], 'In review'),
    ];
    expect(
      planSync({
        board,
        issues: [],
        waitsForOwner: new Set([1]),
        skip: new Set(),
      }),
    ).toEqual([
      { type: 'move', itemId: 'C1', number: 1, column: 'Waiting for you' },
    ]);
  });
  it("reads a needs-owner card moved to Ready as the owner's go-ahead, and does not move it back", () => {
    const board = [issueCard('C1', 1, ['agent:needs-owner'], 'Ready')];
    expect(
      planSync({
        board,
        issues: [],
        waitsForOwner: new Set(),
        skip: new Set(),
      }),
    ).toEqual([{ type: 'go', number: 1 }]);
  });
  it('leaves cards of other repos and skipped issues (the activity issue) alone', () => {
    const board = [
      {
        ...issueCard('C1', 1, [], 'Ready'),
        content: {
          ...issueCard('C1', 1, [], 'Ready').content,
          repo: 'someone/else',
        },
      },
      issueCard('C2', 134, [], null),
    ];
    expect(
      planSync({
        board,
        issues: [repoIssue(134)],
        waitsForOwner: new Set(),
        skip: new Set([134]),
      }),
    ).toEqual([]);
  });
});

describe('readyRank', () => {
  it('gives the Ready cards their order on the board', () => {
    const board = [
      issueCard('C1', 7, ['agent:ready'], 'Ready'),
      issueCard('C2', 3, [], 'Inbox'),
      issueCard('C3', 5, ['agent:ready'], 'Ready'),
    ];
    expect([...readyRank(board)]).toEqual([
      [7, 0],
      [5, 1],
    ]);
  });
});
