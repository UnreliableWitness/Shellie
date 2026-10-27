// A review carries over GitHub's "Update branch": a merge of main into the PR that GitHub made (it refuses when
// there is a conflict), so the PR's own code is what was reviewed. Without this, bringing a PR up to date cost a
// full new review every time another PR merged.
const MERGE_OF_MAIN = /^Merge branch 'main' into /;

/**
 * @param {{ getCommit(sha: string): Promise<any> }} gh
 * @param {string} head the PR's head commit
 * @param {Record<string, any>} reviews the PR's reviews by commit
 * @returns {Promise<{ sha: string, review: any } | null>} the review of the last reviewed commit, when only
 *   GitHub's merges of main came after it
 */
export async function carriedReview(gh, head, reviews) {
  let sha = head;
  for (let i = 0; i < 10; i++) {
    const c = await gh.getCommit(sha);
    const isMergeOfMain =
      c?.parents?.length === 2 &&
      MERGE_OF_MAIN.test(c.commit?.message ?? '') &&
      c.commit?.committer?.name === 'GitHub';
    if (!isMergeOfMain) return null;
    sha = c.parents[0].sha;
    const review = reviews[sha];
    if (review) return review.verdict === 'error' ? null : { sha, review };
  }
  return null;
}
