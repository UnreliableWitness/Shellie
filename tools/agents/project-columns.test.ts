import { describe, expect, it } from 'vitest';
import { columnFor, COLUMNS, ownerIntent } from './project-columns.mjs';

const issue = (labels: string[], state = 'OPEN') => ({ state, labels });

describe('columnFor', () => {
  it('follows the agent labels, the furthest step winning', () => {
    expect(columnFor(issue([]))).toBe('Inbox');
    expect(columnFor(issue(['agent:awaiting-approval']))).toBe('Inbox');
    expect(columnFor(issue(['agent:needs-info']))).toBe('Needs info');
    expect(columnFor(issue(['agent:needs-owner']))).toBe('Needs you');
    expect(columnFor(issue(['agent:ready', 'kind:bug']))).toBe('Ready');
    expect(columnFor(issue(['agent:ready', 'claude-working']))).toBe(
      'In progress',
    );
    expect(columnFor(issue(['claude-working', 'agent:pr-open']))).toBe(
      'In review',
    );
    expect(
      columnFor(issue(['claude-working', 'agent:pr-open']), {
        prWaitsForOwner: true,
      }),
    ).toBe('Waiting for you');
    expect(columnFor(issue(['agent:merged'], 'CLOSED'))).toBe('Merged');
    expect(columnFor(issue(['agent:released'], 'CLOSED'))).toBe('Released');
  });
  it('puts a closed issue without a release in Closed', () => {
    expect(columnFor(issue(['kind:bug'], 'CLOSED'))).toBe('Closed');
  });
  it('lists every column it can return', () => {
    for (const c of [
      'Inbox',
      'Needs info',
      'Needs you',
      'Ready',
      'In progress',
      'In review',
      'Waiting for you',
      'Merged',
      'Released',
      'Closed',
    ])
      expect(COLUMNS).toContain(c);
  });
});

describe('ownerIntent', () => {
  it('reads a card moved to Ready while it waits for the owner as agent:go', () => {
    expect(
      ownerIntent({ column: 'Ready', issue: issue(['agent:needs-owner']) }),
    ).toBe('go');
    // a needs-info issue waits for the reporter's answer; agent:go does nothing there
    expect(
      ownerIntent({ column: 'Ready', issue: issue(['agent:needs-info']) }),
    ).toBeNull();
  });
  it('ignores every other difference: the labels decide, the sync moves the card back', () => {
    expect(
      ownerIntent({ column: 'Ready', issue: issue(['agent:ready']) }),
    ).toBeNull();
    expect(
      ownerIntent({ column: 'Released', issue: issue(['agent:needs-owner']) }),
    ).toBeNull();
    expect(
      ownerIntent({
        column: 'Ready',
        issue: issue(['agent:needs-owner', 'agent:go']),
      }),
    ).toBeNull();
  });
});
