// Checks the publish job makes on what the implement job handed over, before anything is pushed (spec 5.2, 6.2).
// The implement job ran an agent that executes code, so its bundle and result are untrusted input here.
import { defang } from './state.mjs';

/** Paths an agent PR may never touch: the agents' own rules, workflows, release and signing. */
const DENIED = [
  '.github/workflows/**',
  '.github/agents/**',
  '.github/CODEOWNERS',
  '.claude/skills/sdlc-*/**',
  'tools/agents/**',
  'tools/release/**',
  'tools/forge/macSigning.mjs',
  'assets/entitlements.mac.plist',
];
/** Paths an agent PR may touch, but then only the owner merges it. */
const OWNER_ONLY = [
  'forge.config.mts',
  'src/main/autoUpdate.ts',
  'src/main/secrets/**',
  'src/main/costServer/**',
  'src/main/ledger/**',
  'src/main/migrate/**',
  'package.json',
  // stage 3, before anything merges by itself: config that runs code or steers agents
  '.claude/**',
  'scripts/**',
  '.npmrc',
  '.mcp.json',
  'vite.*.config.mts',
  'vitest.config.mts',
  'package-lock.json',
];
const UNCOUNTED = new Set(['package-lock.json', 'CLAUDE.md']);

const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .split('**')
      .map((part) =>
        part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
      )
      .join('.*')}$`,
  );
const DENIED_RE = DENIED.map(globToRegExp);
const OWNER_RE = OWNER_ONLY.map(globToRegExp);

/** @param {string[]} files @returns {{ denied: string[], ownerOnly: string[] }} */
export function classifyPaths(files, { claudeMdAddsOnly = true } = {}) {
  return {
    denied: files.filter((f) => DENIED_RE.some((r) => r.test(f))),
    // CLAUDE.md steers every later agent: adding a Status line is fine, changing what is there is the owner's call
    ownerOnly: files.filter(
      (f) =>
        !DENIED_RE.some((r) => r.test(f)) &&
        (OWNER_RE.some((r) => r.test(f)) ||
          (f === 'CLAUDE.md' && !claudeMdAddsOnly)),
    ),
  };
}

/** @param {string} numstat `git diff -z --numstat` @returns {boolean} CLAUDE.md is unchanged or only gains lines */
export function claudeMdAddsOnly(numstat) {
  for (const line of numstat.split(/\0|\n/)) {
    const [, del, ...rest] = line.split('\t');
    if (rest.join('\t') === 'CLAUDE.md') return del === '0';
  }
  return true;
}

/**
 * @param {string} numstat `git diff --numstat` output, NUL- (`-z`) or newline-separated
 * @returns {number} added + deleted lines that count
 */
export function countChangedLines(numstat) {
  let total = 0;
  for (const line of numstat.split(/\0|\n/)) {
    const [add, del, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!file || UNCOUNTED.has(file) || add === '-') continue;
    total += Number(add) + Number(del);
  }
  return total;
}

/** @param {number} n @param {string} title @returns {string} `agent/issues/<n>-<slug>` */
export function branchName(n, title) {
  const slug = (title.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `agent/issues/${n}-${slug || 'fix'}`;
}

/**
 * @param {{ heads: string[], branch: string, isAncestor: boolean, commitCount: number }} b
 *   heads: the refs in the bundle; isAncestor: the base commit `pick` saw is an ancestor of the head
 */
export function verifyBundle({ heads, branch, isAncestor, commitCount }) {
  const fail = (error) => ({ ok: /** @type {const} */ (false), error });
  if (heads.length !== 1 || heads[0] !== `refs/heads/${branch}`)
    return fail(
      `expected only refs/heads/${branch}, got ${heads.join(', ') || 'nothing'}`,
    );
  if (!isAncestor)
    return fail('the branch does not start from the main commit it was given');
  if (commitCount < 1) return fail('no commits');
  if (commitCount > 50) return fail(`${commitCount} commits, more than 50`);
  return { ok: /** @type {const} */ (true) };
}

const str = (v, max) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** @param {unknown} x the implement agent's answer */
export function validateImplementResult(x) {
  const o = /** @type {any} */ (x);
  const bad = (error) => ({ ok: /** @type {const} */ (false), error });
  if (!o || typeof o !== 'object') return bad('no object');
  if (o.status === 'blocked')
    return str(o.reason, 5000)
      ? { ok: true, value: o }
      : bad('blocked needs a reason');
  if (o.status !== 'done') return bad(`unknown status ${String(o.status)}`);
  if (!str(o.prTitle, 120) || /\n/.test(o.prTitle))
    return bad('PR title must be one line of 1-120 characters');
  if (!str(o.prBody, 20000)) return bad('PR body must be 1-20000 characters');
  if (!['low', 'high'].includes(o.risk)) return bad('bad risk');
  return { ok: true, value: o };
}

/** @param {string} title @param {number} n */
export function prTitle(title, n) {
  return new RegExp(`#${n}(?!\\d)`).test(title) ? title : `${title} (#${n})`;
}

/** @param {string} body @param {number} n @param {string[]} notes what the publish job found */
const ATTRIBUTION =
  '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
const fence = (text) => '```\n' + text.replace(/```/g, "'''") + '\n```';

/**
 * @param {string} body the agent's text
 * @param {number} n
 * @param {string[]} notes what the publish job found
 * @param {Record<string, string>} [checkOutput] the tail of each failing check's output, shown folded
 */
export function prBody(body, n, notes, checkOutput = {}) {
  const outputs = Object.entries(checkOutput)
    .filter(([, text]) => text)
    .map(
      ([name, text]) =>
        `<details><summary>${name === 'test' ? 'npm test' : `npm run ${name}`} output</summary>\n\n${fence(text.length > 1500 ? `${text.slice(0, 1500)}\n…` : text)}\n\n</details>`,
    );
  return [
    // only the script's own "Fixes #n" may close an issue, and the attribution line is added once, below
    defang(body)
      .replaceAll(ATTRIBUTION, '')
      .trim()
      .replace(
        /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi,
        'refs #$1',
      ),
    notes.length
      ? `### Agent checks\n\n${notes.map((x) => `- ${x}`).join('\n')}${outputs.length ? `\n\n${outputs.join('\n\n')}` : ''}`
      : '',
    `Fixes #${n}`,
    ATTRIBUTION,
  ]
    .filter(Boolean)
    .join('\n\n');
}
