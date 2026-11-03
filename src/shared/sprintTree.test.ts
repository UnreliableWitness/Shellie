import { describe, expect, it } from 'vitest';
import {
  buildSprintTree,
  HIERARCHY_FORWARD,
  type SprintRelation,
} from './sprintTree';
import type { SprintItem } from './types';

const item = (id: number): SprintItem => ({
  id: String(id),
  type: 'Task',
  title: `Item ${id}`,
  state: 'To Do',
  areaPath: 'Shellie',
  iterationPath: 'Shellie\\Sprint 1',
  assignedTo: null,
  url: `https://example/${id}`,
  project: null,
  remainingWork: null,
  originalEstimate: null,
  completedWork: null,
});
const top = (id: number): SprintRelation => ({
  rel: null,
  source: null,
  target: { id },
});
const child = (parent: number, id: number): SprintRelation => ({
  rel: HIERARCHY_FORWARD,
  source: { id: parent },
  target: { id },
});
const shape = (relations: SprintRelation[], ids: number[]) =>
  buildSprintTree(relations, ids.map(item)).map((r) => [
    r.item.id,
    r.depth,
    r.parentId,
    r.hasChildren,
  ]);

describe('buildSprintTree', () => {
  it('keeps the API order of top-level items exactly', () => {
    expect(shape([top(3), top(1), top(2)], [1, 2, 3])).toEqual([
      ['3', 0, null, false],
      ['1', 0, null, false],
      ['2', 0, null, false],
    ]);
  });
  it('nests children under their parent in API order, at any depth', () => {
    expect(
      shape(
        [top(1), child(1, 5), child(5, 7), child(1, 6), top(2)],
        [1, 2, 5, 6, 7],
      ),
    ).toEqual([
      ['1', 0, null, true],
      ['5', 1, '1', true],
      ['7', 2, '5', false],
      ['6', 1, '1', false],
      ['2', 0, null, false],
    ]);
  });
  it('puts a child after its parent even when the API lists it first', () => {
    expect(shape([child(1, 5), top(2), top(1)], [1, 2, 5])).toEqual([
      ['2', 0, null, false],
      ['1', 0, null, true],
      ['5', 1, '1', false],
    ]);
  });
  it('shows a child whose parent is outside the sprint at top level, in place', () => {
    expect(shape([top(1), child(99, 5), top(2)], [1, 2, 5])).toEqual([
      ['1', 0, null, false],
      ['5', 0, null, false],
      ['2', 0, null, false],
    ]);
  });
  it('treats a parent that could not be read as outside the sprint', () => {
    expect(shape([top(1), child(1, 5)], [5])).toEqual([['5', 0, null, false]]);
  });
  it('returns no rows for an empty sprint', () => {
    expect(buildSprintTree([], [])).toEqual([]);
  });
  it('keeps the first entry of a duplicated relation', () => {
    expect(shape([top(1), child(1, 5), top(5), top(1)], [1, 5])).toEqual([
      ['1', 0, null, true],
      ['5', 1, '1', false],
    ]);
  });
  it('ignores a source on a relation that is not a hierarchy link', () => {
    expect(
      shape(
        [
          top(1),
          {
            rel: 'System.LinkTypes.Related',
            source: { id: 1 },
            target: { id: 2 },
          },
        ],
        [1, 2],
      ),
    ).toEqual([
      ['1', 0, null, false],
      ['2', 0, null, false],
    ]);
  });
  it('breaks a parent cycle instead of looping', () => {
    expect(shape([child(2, 1), child(1, 2)], [1, 2])).toEqual([
      ['1', 0, null, false],
      ['2', 0, null, false],
    ]);
  });
  it('passes the work item through', () => {
    const rows = buildSprintTree([top(1)], [{ ...item(1), remainingWork: 3 }]);
    expect(rows[0].item.remainingWork).toBe(3);
  });
});
