import { describe, expect, it } from 'vitest';
import type { TaskSignal } from '../shared/pulse';
import type { TaskView } from '../shared/types';
import { rowTitle, taskMark } from './taskMark';

const task = (over: Partial<TaskView> = {}): TaskView =>
  ({ id: 't', status: 'ready', worktreeMissing: false, ...over }) as TaskView;
const signal = (over: Partial<TaskSignal> = {}): TaskSignal => ({
  state: 'none',
  story: '',
  prWorkspaceId: null,
  ...over,
});
const waits = signal({ state: 'waits', story: 'CI failing: build' });
const merged = signal({ state: 'merged', story: 'PR merged' });

describe('taskMark', () => {
  it('is broken for a missing worktree, before anything a PR says', () => {
    expect(taskMark(task({ worktreeMissing: true }), waits)).toEqual({
      kind: 'broken',
      label: 'Worktree folder missing',
    });
  });
  it('is broken for a failed setup', () => {
    expect(taskMark(task({ status: 'setup-failed' }), merged)).toEqual({
      kind: 'broken',
      label: 'Setup failed',
    });
  });
  it('is busy while setting up or finishing, whatever the signal says', () => {
    expect(taskMark(task({ status: 'setting-up' }), waits)).toEqual({
      kind: 'busy',
      label: 'Setting up',
    });
    expect(taskMark(task({ status: 'finishing' }), merged)).toEqual({
      kind: 'busy',
      label: 'Finishing',
    });
  });
  it('waits with the story as its label', () => {
    expect(taskMark(task(), waits)).toEqual({
      kind: 'waits',
      label: 'CI failing: build',
    });
  });
  it('waits with a plain label when there is no story', () => {
    expect(taskMark(task(), signal({ state: 'waits' }))?.label).toBe(
      'Waiting for you',
    );
  });
  it('is merged for a ready task whose PRs are merged', () => {
    expect(taskMark(task(), merged)).toEqual({
      kind: 'merged',
      label: 'Merged: finish this task',
    });
  });
  it('is nothing for a quiet task, a missing signal or a done task', () => {
    expect(taskMark(task(), signal({ story: 'waiting 2d' }))).toBeNull();
    expect(taskMark(task(), null)).toBeNull();
    expect(taskMark(task({ status: 'done' }), waits)).toBeNull();
  });
});

describe('rowTitle', () => {
  it('leads with the mark, then the repos, then the cost', () => {
    expect(
      rowTitle({
        mark: { kind: 'waits', label: 'CI failing: build' },
        story: 'CI failing: build',
        repos: 'webshop +1 repo',
        cost: 1.5,
      }),
    ).toBe('CI failing: build\nwebshop +1 repo\n€1.50');
  });
  it('leaves the PR story out for a busy or broken task', () => {
    expect(
      rowTitle({
        mark: { kind: 'busy', label: 'Setting up' },
        story: 'CI failing',
        repos: 'webshop',
        cost: 0,
      }),
    ).toBe('Setting up\nwebshop');
  });
  it('tells the story of a task without a mark', () => {
    expect(
      rowTitle({ mark: null, story: 'waiting 2d', repos: '', cost: 0 }),
    ).toBe('waiting 2d');
  });
  it('is empty when there is nothing to say', () => {
    expect(rowTitle({ mark: null, story: '', repos: '', cost: 0 })).toBe('');
  });
});
