import { describe, expect, it, vi } from 'vitest';
import type { AdoClient } from '../services/AdoClient';
import { AzureDevOpsTracker } from './AzureDevOpsTracker';
import type { Tracker } from './Tracker';

const table: [keyof Tracker, keyof AdoClient, unknown[]][] = [
  ['probe', 'verify', ['P']],
  ['currentIteration', 'currentIteration', ['P', 'Team']],
  ['iteration', 'sprint', ['P', 'it-2']],
  ['iterations', 'iterations', ['P']],
  ['items', 'workItems', ['P', [1, 2]]],
  ['searchItems', 'searchWorkItems', [{ project: 'P', text: 'x' }]],
  ['itemTypes', 'workItemTypes', ['P']],
  ['iconDataUrl', 'iconDataUrl', ['https://i']],
  ['typeStates', 'typeStates', ['P', 'Bug']],
  ['itemForStart', 'workItemForStart', [7]],
  ['updateItem', 'updateWorkItem', [7, { state: 'Active' }]],
  ['itemEstimate', 'workItemEstimate', [7]],
  ['updateItemFields', 'updateWorkItemFields', [7, { f: 1 }]],
  ['repositoryId', 'repositoryId', ['P', 'repo']],
  ['findActivePullRequest', 'findActivePullRequest', ['P', 'r', 'b']],
  ['createPullRequest', 'createPullRequest', ['P', 'r', { title: 't' }]],
  ['pullRequest', 'pullRequest', ['P', 'r', 7]],
];

describe('AzureDevOpsTracker', () => {
  it.each(table)(
    '%s delegates to AdoClient.%s',
    async (name, clientName, args) => {
      const fn = vi.fn().mockResolvedValue('result');
      const tracker = new AzureDevOpsTracker({
        [clientName]: fn,
      } as unknown as AdoClient);
      const call = tracker[name] as (...a: unknown[]) => Promise<unknown>;
      await expect(call(...args)).resolves.toBe('result');
      expect(fn).toHaveBeenCalledWith(...args);
    },
  );
});
