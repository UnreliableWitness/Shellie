import { describe, expect, it } from 'vitest';
import { createGitHub } from './github.mjs';

// The pollers call these on the real client; the fakes in the other tests cannot catch a missing one.
describe('createGitHub', () => {
  it('has every call the pollers use', () => {
    const gh = createGitHub('o/r', 'token');
    for (const name of [
      'listOpenIssues',
      'listComments',
      'comment',
      'editComment',
      'addLabels',
      'removeLabel',
      'close',
      'listLabels',
      'createLabel',
      'listBranches',
      'listOpenPulls',
      'findIssueByLabel',
      'createIssue',
      'editIssueBody',
      'getIssue',
      'listPullFiles',
      'createReview',
      'getPull',
      'listCheckRuns',
      'listMainCiRuns',
      'deleteBranch',
      'listReviews',
      'listPrComments',
      'listPullFileStats',
      'updateBranch',
      'mergePull',
      'jobLogTail',
      'mainSha',
      'createPull',
      'listIssuesByLabel',
      'listRecentlyClosedByLabel',
      'reopen',
      'rerunFailedJobs',
      'getCommit',
      'commitFiles',
      'listReleases',
      'compare',
      'listRecentIssues',
    ])
      expect(typeof (gh as Record<string, unknown>)[name], name).toBe(
        'function',
      );
  });
});
