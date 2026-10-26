// Checks the publish job makes on what the implement job handed over, before anything is pushed (spec 5.2, 6.2).
// The implement job ran an agent that executes code, so its bundle and result are untrusted input here.

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
export function classifyPaths(files) {
  return {
    denied: files.filter((f) => DENIED_RE.some((r) => r.test(f))),
    ownerOnly: files.filter((f) => OWNER_RE.some((r) => r.test(f))),
  };
}

/** @param {string} numstat `git diff --numstat` output @returns {number} added + deleted lines that count */
export function countChangedLines(numstat) {
  let total = 0;
  for (const line of numstat.split('\n')) {
    const [add, del, file] = line.split('\t');
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
export function prBody(body, n, notes) {
  return [
    body.trim(),
    notes.length
      ? `### Agent checks\n\n${notes.map((x) => `- ${x}`).join('\n')}`
      : '',
    `Fixes #${n}`,
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ]
    .filter(Boolean)
    .join('\n\n');
}
