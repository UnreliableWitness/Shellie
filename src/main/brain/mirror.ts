import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrainWiki, RefreshResult } from '../../shared/brain';
import { errorMessage } from '../../shared/errors';
import type { GitClient } from '../services/GitClient';
import { parseSourceFrontmatter, renderSource, sha256 } from './sourceFile';

/** Env for git (the auth header), built by the caller from the connection's PAT. */
export type MirrorAuth = () => Promise<Record<string, string>>;

export type { RefreshResult };

const WIKI_DIR = 'sources/wiki';

export function mirrorDir(brainDir: string): string {
  return path.join(brainDir, '.mirror');
}

const segments = (posix: string) => posix.split('/').filter(Boolean);

/** '/' + the segments of the parts, no trailing or double slashes; '' for nothing. */
function joinPosix(...parts: string[]): string {
  const segs = parts.flatMap(segments);
  return segs.length ? '/' + segs.join('/') : '';
}

const stripMd = (p: string) => p.replace(/\.md$/i, '');

/** `rootGitItemPath` is the root page's file path from the pages list; unused for rootPath '/'. */
export function sparsePatterns(
  wiki: BrainWiki,
  rootGitItemPath = '',
): string[] {
  if (wiki.rootPath === '/') return [joinPosix(wiki.mappedPath, '**')];
  return [
    joinPosix(wiki.mappedPath, rootGitItemPath),
    joinPosix(wiki.mappedPath, stripMd(rootGitItemPath), '**'),
  ];
}

/** Wiki file or folder name to page name: '-' is a space, then percent-decoding. */
export function decodeName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/-/g, ' '));
  } catch {
    return name;
  }
}

/** Makes a decoded page name safe as one file or folder name on every platform. */
function safeSegment(name: string): string {
  const s = name
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\\u0000-\u001f:?*"<>|]/g, '_')
    .replace(/[. ]+$/, '');
  return s === '' || s === '.' || s === '..' ? '_' : s;
}

const isFile = (p: string) =>
  fs.stat(p).then(
    (s) => s.isFile(),
    () => false,
  );

/** Posix paths, relative to `dir`, of every .md file below it (not in .attachments or .git). */
async function walk(dir: string, rel = ''): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(path.join(dir, ...segments(rel)), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === '.attachments' || e.name === '.git') continue;
      out.push(...(await walk(dir, next)));
    } else if (e.name.toLowerCase().endsWith('.md')) out.push(next);
  }
  return out;
}

async function pruneEmptyDirs(dir: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(dir, e.name);
    await pruneEmptyDirs(sub);
    if ((await fs.readdir(sub)).length === 0) await fs.rmdir(sub);
  }
}

async function syncMirror(
  git: GitClient,
  brainDir: string,
  wiki: BrainWiki,
  rootGitItemPath: string,
  env: Record<string, string>,
): Promise<void> {
  const mirror = mirrorDir(brainDir);
  const cloned = await fs.stat(path.join(mirror, '.git')).then(
    () => true,
    () => false,
  );
  let sameRemote = false;
  if (cloned) {
    try {
      sameRemote =
        (await git.run(mirror, ['remote', 'get-url', 'origin'])).trim() ===
        wiki.gitUrl;
    } catch {
      sameRemote = false;
    }
  }
  if (cloned && sameRemote) {
    await git.run(mirror, ['fetch', '-q', 'origin', wiki.version], { env });
    await git.run(mirror, ['reset', '-q', '--hard', `origin/${wiki.version}`], {
      env,
    });
    // The root page or mapped path may have changed since the last refresh.
    await git.run(
      mirror,
      [
        'sparse-checkout',
        'set',
        '--no-cone',
        ...sparsePatterns(wiki, rootGitItemPath),
      ],
      { env },
    );
    return;
  }
  await fs.rm(mirror, { recursive: true, force: true });
  try {
    await git.run(
      brainDir,
      [
        'clone',
        '-q',
        '--filter=blob:none',
        '--no-checkout',
        '--branch',
        wiki.version,
        wiki.gitUrl,
        '.mirror',
      ],
      { env },
    );
    await git.run(
      mirror,
      [
        'sparse-checkout',
        'set',
        '--no-cone',
        ...sparsePatterns(wiki, rootGitItemPath),
      ],
      { env },
    );
    await git.run(mirror, ['checkout', '-q', wiki.version], { env });
  } catch (e) {
    await fs.rm(mirror, { recursive: true, force: true });
    throw e;
  }
}

/** Mirrors the chosen wiki subtree into sources/wiki/ and commits what changed. Never throws. */
export async function refreshMirror(
  git: GitClient,
  brainDir: string,
  wiki: BrainWiki,
  rootGitItemPath: string,
  auth: MirrorAuth,
  pageUrl: (gitItemPath: string) => string,
  now: () => Date = () => new Date(),
): Promise<RefreshResult> {
  try {
    await syncMirror(git, brainDir, wiki, rootGitItemPath, await auth());

    const mirror = mirrorDir(brainDir);
    const wholeWiki = wiki.rootPath === '/';
    const folder = joinPosix(
      wiki.mappedPath,
      wholeWiki ? '' : stripMd(rootGitItemPath),
    );
    // Children keep the root page's folder name: Second-brain/Kick.md -> "Second brain/Kick.md".
    const relBase = wholeWiki ? folder : path.posix.dirname(folder);
    const rootFile = wholeWiki
      ? null
      : joinPosix(wiki.mappedPath, rootGitItemPath);

    // Repo-relative posix paths ('/'-prefixed) of every page in the subtree.
    const found = (await walk(path.join(mirror, ...segments(folder)))).map(
      (r) => joinPosix(folder, r),
    );
    if (rootFile && (await isFile(path.join(mirror, ...segments(rootFile)))))
      found.push(rootFile);

    const wikiRoot = path.join(brainDir, ...segments(WIKI_DIR));
    const existing = new Map<string, string>(); // relative posix path -> sha256
    for (const rel of await walk(wikiRoot)) {
      const text = await fs.readFile(
        path.join(wikiRoot, ...segments(rel)),
        'utf8',
      );
      existing.set(rel, parseSourceFrontmatter(text)?.sha256 ?? '');
    }

    let added = 0;
    let changed = 0;
    const warnings: string[] = [];
    const kept = new Set<string>();
    for (const gitItemPath of found) {
      const relSegs =
        gitItemPath === rootFile
          ? [path.posix.basename(gitItemPath)]
          : segments(gitItemPath.slice(relBase.length));
      const rawNames = relSegs.map(decodeName);
      const decoded = rawNames.map(safeSegment);
      const rel = decoded.join('/');
      const target = path.join(wikiRoot, ...decoded);
      if (!path.resolve(target).startsWith(wikiRoot + path.sep)) {
        warnings.push(`Skipped ${gitItemPath}: unsafe page name`);
        continue;
      }
      kept.add(rel);
      const text = await fs.readFile(
        path.join(mirror, ...segments(gitItemPath)),
        'utf8',
      );
      const hash = sha256(text);
      const prev = existing.get(rel);
      if (prev === hash) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(
        target,
        renderSource(
          {
            title: stripMd(rawNames[rawNames.length - 1]),
            source_url: pageUrl(gitItemPath),
            ingested_at: now().toISOString(),
            content_type: 'wiki-page',
            sha256: hash,
          },
          text,
        ),
      );
      if (prev === undefined) added++;
      else changed++;
    }

    let removed = 0;
    for (const rel of existing.keys()) {
      if (kept.has(rel)) continue;
      await fs.rm(path.join(wikiRoot, ...segments(rel)), { force: true });
      removed++;
    }
    await pruneEmptyDirs(wikiRoot);

    if (added + changed + removed > 0) {
      await git.run(brainDir, ['add', '-A', WIKI_DIR]);
      await git.run(brainDir, [
        'commit',
        '-m',
        `Brain: refresh wiki mirror (+${added} ~${changed} -${removed})`,
      ]);
    }
    return {
      ok: true,
      added,
      changed,
      removed,
      pages: found.length - warnings.length,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}
