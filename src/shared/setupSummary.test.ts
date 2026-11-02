import { describe, expect, it } from 'vitest';
import { inProgressState } from './setupSummary';
import type { StartSettings, WorkItemTypeMeta } from './types';

const bug: WorkItemTypeMeta = {
  name: 'Bug',
  color: null,
  icon: null,
  states: [
    { name: 'New', category: 'Proposed', color: null },
    { name: 'Active', category: 'InProgress', color: null },
    { name: 'Investigating', category: 'InProgress', color: null },
    { name: 'Resolved', category: 'Resolved', color: null },
  ],
};
const start = (stateOverrides: Record<string, string>): StartSettings => ({
  moveToInProgress: true,
  assignToMe: true,
  stateOverrides,
});

describe('inProgressState', () => {
  it('uses an override that is an In Progress state of the type', () => {
    expect(inProgressState('Bug', start({ Bug: 'Investigating' }), [bug])).toBe(
      'Investigating',
    );
  });

  it('ignores an override that is not an In Progress state, like Start does', () => {
    expect(inProgressState('Bug', start({ Bug: 'Resolved' }), [bug])).toBe(
      'Active',
    );
    expect(inProgressState('Bug', start({ Bug: 'Gone' }), [bug])).toBe(
      'Active',
    );
  });

  it('matches the type name exactly, like Start does', () => {
    expect(inProgressState('bug', start({}), [bug])).toBe('In Progress');
  });

  it('takes the override as it is when the types are unknown', () => {
    expect(inProgressState('Bug', start({ Bug: 'Doing' }), null)).toBe('Doing');
    expect(inProgressState('Bug', start({}), null)).toBe('In Progress');
  });
});
