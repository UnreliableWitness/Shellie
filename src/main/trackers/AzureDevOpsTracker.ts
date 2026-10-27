import type { AdoClient } from '../services/AdoClient';
import type { Tracker } from './Tracker';

/** The Tracker for Azure DevOps: pure delegation to the AdoClient. */
export class AzureDevOpsTracker implements Tracker {
  constructor(private readonly client: AdoClient) {}

  probe: Tracker['probe'] = (...a) => this.client.verify(...a);
  currentIteration: Tracker['currentIteration'] = (...a) =>
    this.client.currentIteration(...a);
  iteration: Tracker['iteration'] = (...a) => this.client.sprint(...a);
  iterations: Tracker['iterations'] = (...a) => this.client.iterations(...a);
  items: Tracker['items'] = (...a) => this.client.workItems(...a);
  searchItems: Tracker['searchItems'] = (...a) =>
    this.client.searchWorkItems(...a);
  itemTypes: Tracker['itemTypes'] = (...a) => this.client.workItemTypes(...a);
  iconDataUrl: Tracker['iconDataUrl'] = (...a) => this.client.iconDataUrl(...a);
  typeStates: Tracker['typeStates'] = (...a) => this.client.typeStates(...a);
  itemForStart: Tracker['itemForStart'] = (...a) =>
    this.client.workItemForStart(...a);
  updateItem: Tracker['updateItem'] = (...a) =>
    this.client.updateWorkItem(...a);
  itemEstimate: Tracker['itemEstimate'] = (...a) =>
    this.client.workItemEstimate(...a);
  updateItemFields: Tracker['updateItemFields'] = (...a) =>
    this.client.updateWorkItemFields(...a);
  repositoryId: Tracker['repositoryId'] = (...a) =>
    this.client.repositoryId(...a);
  findActivePullRequest: Tracker['findActivePullRequest'] = (...a) =>
    this.client.findActivePullRequest(...a);
  createPullRequest: Tracker['createPullRequest'] = (...a) =>
    this.client.createPullRequest(...a);
  pullRequest: Tracker['pullRequest'] = (...a) => this.client.pullRequest(...a);
}
