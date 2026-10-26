// Whether main has changes that go into the app since the last release: a push that only touches the agent
// pipeline, docs, art sources, design, tests or dev tools makes no new version. Anything not listed here counts
// as part of the app, so a new kind of file errs towards releasing.
// Run from CI on main: prints "true" or "false" for the files changed since the newest vX.Y.Z tag.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const NOT_APP = [
  /^\.github\//,
  /^\.claude\//,
  /^docs\//,
  /^design\//,
  /^tools\/(agents|art|ado|telemetry|release)\//,
  /^tools\/budget-check\.mjs$/,
  /^[^/]+\.md$/,
  /^assets\/ART\.md$/,
  /^assets\/agents\//,
  /\.test\.tsx?$/,
  /(^|\/)test-helpers\//,
  /^src\/main\/ipc\/handlersHarness\.ts$/,
  /^src\/renderer\/test-setup\.ts$/,
  /^vitest\.config\.mts$/,
  /^\.(oxlintrc|oxfmtrc)\.json$/,
  /^\.git(ignore|attributes)$/,
  /^LICENSE$/,
];

/** @param {string[]} files changed paths @returns {boolean} at least one of them goes into the app */
export function needsRelease(files) {
  return files.some((f) => !NOT_APP.some((re) => re.test(f)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8' }).trim();
  const tag = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n')[0];
  // no release yet: release
  const files = tag
    ? git('diff', '--name-only', `${tag}`, 'HEAD').split('\n').filter(Boolean)
    : ['(no release yet)'];
  console.log(String(needsRelease(files)));
}
