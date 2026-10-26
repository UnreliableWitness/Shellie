import type { AdoClient } from '../services/AdoClient';

/**
 * What the IPC handlers need from an issue tracker, under neutral names.
 * Parameter and return types are those of the Azure DevOps client.
 */
export interface Tracker {
  probe: AdoClient['verify'];
  currentIteration: AdoClient['currentIteration'];
  iteration: AdoClient['sprint'];
  iterations: AdoClient['iterations'];
  items: AdoClient['workItems'];
  searchItems: AdoClient['searchWorkItems'];
  itemTypes: AdoClient['workItemTypes'];
  iconDataUrl: AdoClient['iconDataUrl'];
  typeStates: AdoClient['typeStates'];
  itemForStart: AdoClient['workItemForStart'];
  updateItem: AdoClient['updateWorkItem'];
  itemEstimate: AdoClient['workItemEstimate'];
  updateItemFields: AdoClient['updateWorkItemFields'];
  repositoryId: AdoClient['repositoryId'];
  findActivePullRequest: AdoClient['findActivePullRequest'];
  createPullRequest: AdoClient['createPullRequest'];
  pullRequest: AdoClient['pullRequest'];
}
