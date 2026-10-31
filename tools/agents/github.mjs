// A thin `gh api` wrapper for the agent scripts. The token is passed to gh's own environment only,
// never put in process.env, so an agent started from the same process cannot inherit it.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';

/**
 * The App token, handed over in a file the script reads and deletes at once, so it is never in an
 * environment an agent started by this process could see.
 * @param {string | undefined} path
 */
export function readTokenFile(path) {
  // no path, or no file (the optional project token when its secret is not set): no token
  if (!path || !existsSync(path)) return undefined;
  const token = readFileSync(path, 'utf8').trim();
  rmSync(path, { force: true });
  return token;
}

/**
 * @param {string} repo owner/name
 * @param {string | undefined} token a GitHub App installation token; without one gh uses its own login (local dry runs)
 */
export function createGitHub(repo, token) {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  const api = (path, { method = 'GET', body, paginate = false } = {}) =>
    new Promise((resolve, reject) => {
      const args = [
        'api',
        '-X',
        method,
        path.startsWith('/') ? path.slice(1) : path,
      ];
      if (paginate) args.push('--paginate', '--slurp');
      if (body !== undefined) args.push('--input', '-');
      const child = execFile(
        'gh',
        args,
        { env, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err)
            return reject(
              Object.assign(
                new Error(`gh ${method} ${path}: ${stderr || err.message}`),
                { stderr },
              ),
            );
          resolve(stdout.trim() ? JSON.parse(stdout) : null);
        },
      );
      child.stdin?.end(body === undefined ? '' : JSON.stringify(body));
    });
  const list = async (path) => (await api(path, { paginate: true })).flat();
  const r = `repos/${repo}`;
  const noPulls = (items) => items.filter((i) => !i.pull_request);

  return {
    listOpenIssues: async () =>
      noPulls(await list(`${r}/issues?state=open&per_page=100`)),
    listRecentIssues: async (days) =>
      noPulls(
        await list(
          `${r}/issues?state=all&per_page=100&since=${new Date(Date.now() - days * 86400000).toISOString()}`,
        ),
      ),
    listComments: (n) => list(`${r}/issues/${n}/comments?per_page=100`),
    comment: (n, body) =>
      api(`${r}/issues/${n}/comments`, { method: 'POST', body: { body } }),
    editComment: (id, body) =>
      api(`${r}/issues/comments/${id}`, { method: 'PATCH', body: { body } }),
    addLabels: (n, labels) =>
      api(`${r}/issues/${n}/labels`, { method: 'POST', body: { labels } }),
    removeLabel: (n, label) =>
      api(`${r}/issues/${n}/labels/${encodeURIComponent(label)}`, {
        method: 'DELETE',
      }).catch((e) => {
        if (!/404|Not Found/i.test(e.message)) throw e;
      }),
    close: (n, reason) =>
      api(`${r}/issues/${n}`, {
        method: 'PATCH',
        body: { state: 'closed', state_reason: reason },
      }),
    listLabels: async () =>
      (await list(`${r}/labels?per_page=100`)).map((l) => l.name),
    createLabel: (l) => api(`${r}/labels`, { method: 'POST', body: l }),
    listBranches: async () =>
      (await list(`${r}/branches?per_page=100`)).map((b) => b.name),
    listOpenPulls: () => list(`${r}/pulls?state=open&per_page=100`),
    findIssueByLabel: async (label) =>
      noPulls(
        await api(
          `${r}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`,
        ),
      )[0] ?? null,
    createIssue: (title, body, labels) =>
      api(`${r}/issues`, { method: 'POST', body: { title, body, labels } }),
    editIssueBody: (n, body) =>
      api(`${r}/issues/${n}`, { method: 'PATCH', body: { body } }),
    getIssue: (n) => api(`${r}/issues/${n}`),
    listPullFiles: async (n) =>
      (await list(`${r}/pulls/${n}/files?per_page=100`)).map((f) => f.filename),
    createReview: (n, payload) =>
      api(`${r}/pulls/${n}/reviews`, { method: 'POST', body: payload }),
    getPull: (n) => api(`${r}/pulls/${n}`),
    listCheckRuns: async (sha) =>
      (await api(`${r}/commits/${sha}/check-runs?per_page=100`)).check_runs,
    // newest first, every event (push, schedule, manual): mainState judges main's current commit by all of them
    listMainCiRuns: async () =>
      (await api(`${r}/actions/workflows/ci.yml/runs?branch=main&per_page=20`))
        .workflow_runs,
    deleteBranch: (ref) =>
      api(
        `${r}/git/refs/heads/${ref.split('/').map(encodeURIComponent).join('/')}`,
        { method: 'DELETE' },
      ),
    listReviews: (n) => list(`${r}/pulls/${n}/reviews?per_page=100`),
    // the PR's conversation and its line comments, one list
    listPrComments: async (n) => [
      ...(await list(`${r}/issues/${n}/comments?per_page=100`)),
      ...(await list(`${r}/pulls/${n}/comments?per_page=100`)),
    ],
    listPullFileStats: (n) => list(`${r}/pulls/${n}/files?per_page=100`),
    updateBranch: (n, sha) =>
      api(`${r}/pulls/${n}/update-branch`, {
        method: 'PUT',
        body: { expected_head_sha: sha },
      }),
    // sha: GitHub refuses the merge if the head moved since it was checked
    mergePull: (n, sha) =>
      api(`${r}/pulls/${n}/merge`, {
        method: 'PUT',
        body: { sha, merge_method: 'squash' },
      }),
    jobLogTail: async (id) => {
      const text = await new Promise((resolve, reject) =>
        execFile(
          'gh',
          ['api', `${r}/actions/jobs/${id}/logs`],
          { env, maxBuffer: 64 * 1024 * 1024 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        ),
      );
      return String(text)
        .split('\n')
        .map((l) => l.replace(/^\S+Z /, ''))
        .slice(-150)
        .join('\n')
        .slice(-8000);
    },
    listIssuesByLabel: async (label) =>
      noPulls(
        await list(
          `${r}/issues?state=all&labels=${encodeURIComponent(label)}&per_page=100`,
        ),
      ),
    listRecentlyClosedByLabel: async (label, days) =>
      noPulls(
        await list(
          `${r}/issues?state=closed&labels=${encodeURIComponent(label)}&per_page=100&since=${new Date(Date.now() - days * 86400000).toISOString()}`,
        ),
      ),
    reopen: (n) =>
      api(`${r}/issues/${n}`, { method: 'PATCH', body: { state: 'open' } }),
    getCommit: (sha) => api(`${r}/commits/${sha}`),
    commitFiles: async (sha) =>
      (await api(`${r}/commits/${sha}`)).files.map((f) => f.filename),
    rerunFailedJobs: (runId) =>
      api(`${r}/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST' }),
    listReleases: () => api(`${r}/releases?per_page=20`),
    compare: (base, head) =>
      api(`${r}/compare/${base}...${encodeURIComponent(head)}`),
    mainSha: async () => (await api(`${r}/git/ref/heads/main`)).object.sha,
    createPull: ({ title, body, head }) =>
      api(`${r}/pulls`, {
        method: 'POST',
        body: { title, body, head, base: 'main', maintainer_can_modify: true },
      }),
  };
}
