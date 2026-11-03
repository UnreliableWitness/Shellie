import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrainWiki } from '../../shared/brain';
import { GitClient } from '../services/GitClient';
import {
  commitFile,
  git as sh,
  makeRepo,
  cleanupTempRepos,
} from '../test-helpers/gitRepo';
import { refreshMirror, sparsePatterns, toLf } from './mirror';
import { scaffoldBrain } from './scaffold';
import { parseSourceFrontmatter, sha256 } from './sourceFile';

const ROOT = '/Customers/Acme/Second-brain.md';
const KICK = 'Customers/Acme/Second-brain/Kick%2Doff-notes.md';

describe('wiki mirror', () => {
  const git = new GitClient();
  let tmp: string;
  let dir: string;
  let wikiRepo: string;
  let wiki: BrainWiki;
  const pageUrl = (p: string) => 'https://x' + p;
  const auth = async () => ({});
  const exists = (rel: string) =>
    fs.stat(path.join(dir, rel)).then(
      () => true,
      () => false,
    );
  const count = async () =>
    Number((await git.run(dir, ['rev-list', '--count', 'HEAD'])).trim());
  const put = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(wikiRepo, rel)), { recursive: true });
    commitFile(wikiRepo, rel, text);
  };

  beforeEach(async () => {
    tmp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-mirror-')),
    );
    dir = path.join(tmp, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
    wikiRepo = makeRepo('wiki');
    sh(wikiRepo, 'checkout', '-q', '-b', 'wikiMaster');
    await put('Customers/Acme/Second-brain.md', '# Second brain\n');
    await put(KICK, 'Kick-off\n');
    await put('Customers/Acme/Other.md', 'Other\n');
    wiki = {
      wikiId: 'w',
      wikiName: 'w',
      type: 'projectWiki',
      repositoryId: 'r',
      gitUrl: wikiRepo,
      version: 'wikiMaster',
      mappedPath: '/',
      rootPath: '/Customers/Acme/Second brain',
    };
  });
  afterEach(async () => {
    cleanupTempRepos();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('mirrors the root subtree on first refresh', async () => {
    const r = await refreshMirror(git, dir, wiki, ROOT, auth, pageUrl);
    expect(r).toMatchObject({
      ok: true,
      added: 2,
      changed: 0,
      removed: 0,
      pages: 2,
    });
    expect(await exists('sources/wiki/Second brain.md')).toBe(true);
    expect(await exists('sources/wiki/Second brain/Kick-off notes.md')).toBe(
      true,
    );
    expect(await exists('sources/wiki/Other.md')).toBe(false);
    const text = await fs.readFile(
      path.join(dir, 'sources/wiki/Second brain/Kick-off notes.md'),
      'utf8',
    );
    expect(parseSourceFrontmatter(text)).toMatchObject({
      title: 'Kick-off notes',
      source_url: 'https://x/Customers/Acme/Second-brain/Kick%2Doff-notes.md',
      content_type: 'wiki-page',
    });
    expect(text.endsWith('\n\nKick-off\n')).toBe(true);
    expect((await git.run(dir, ['log', '-1', '--format=%s'])).trim()).toBe(
      'Brain: refresh wiki mirror (+2 ~0 -0)',
    );
  });

  it('writes a CRLF page with LF and hashes it like its LF version', async () => {
    const crlf = 'Line one\r\nLine two\r\n';
    const lf = 'Line one\nLine two\n';
    expect(toLf(crlf)).toBe(lf);
    await put(KICK, crlf);
    const r = await refreshMirror(git, dir, wiki, ROOT, auth, pageUrl);
    expect(r).toMatchObject({ ok: true, added: 2 });
    const file = path.join(dir, 'sources/wiki/Second brain/Kick-off notes.md');
    const text = await fs.readFile(file, 'utf8');
    expect(text).not.toContain('\r');
    expect(text.endsWith(`\n\n${lf}`)).toBe(true);
    expect(parseSourceFrontmatter(text)?.sha256).toBe(sha256(lf));
    // The same page with LF line ends is no change.
    await put(KICK, lf);
    expect(
      await refreshMirror(git, dir, wiki, ROOT, auth, pageUrl),
    ).toMatchObject({ ok: true, added: 0, changed: 0, removed: 0 });
  });

  it('removes mirror files for deleted pages', async () => {
    await refreshMirror(git, dir, wiki, ROOT, auth, pageUrl);
    const before = await count();
    sh(wikiRepo, 'rm', '-q', KICK);
    sh(wikiRepo, 'commit', '-q', '-m', 'rm');
    const r = await refreshMirror(git, dir, wiki, ROOT, auth, pageUrl);
    expect(r).toMatchObject({
      ok: true,
      added: 0,
      changed: 0,
      removed: 1,
      pages: 1,
    });
    expect(await exists('sources/wiki/Second brain/Kick-off notes.md')).toBe(
      false,
    );
    expect(await count()).toBe(before + 1);
  });

  it('reports changed pages and keeps unchanged files untouched', async () => {
    await refreshMirror(
      git,
      dir,
      wiki,
      ROOT,
      auth,
      pageUrl,
      () => new Date('2026-01-01T00:00:00Z'),
    );
    await put(KICK, 'Kick-off v2\n');
    const r = await refreshMirror(
      git,
      dir,
      wiki,
      ROOT,
      auth,
      pageUrl,
      () => new Date('2026-02-02T00:00:00Z'),
    );
    expect(r).toMatchObject({ ok: true, added: 0, changed: 1, removed: 0 });
    const root = await fs.readFile(
      path.join(dir, 'sources/wiki/Second brain.md'),
      'utf8',
    );
    expect(parseSourceFrontmatter(root)?.ingested_at).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('is a no-op commit-wise when nothing changed', async () => {
    await refreshMirror(git, dir, wiki, ROOT, auth, pageUrl);
    const before = await count();
    const r = await refreshMirror(git, dir, wiki, ROOT, auth, pageUrl);
    expect(r).toMatchObject({
      ok: true,
      added: 0,
      changed: 0,
      removed: 0,
      pages: 2,
    });
    expect(await count()).toBe(before);
  });

  it('mirrors the whole wiki for rootPath /', async () => {
    const r = await refreshMirror(
      git,
      dir,
      { ...wiki, rootPath: '/' },
      '',
      auth,
      pageUrl,
    );
    expect(r).toMatchObject({ ok: true, added: 4, pages: 4 });
    expect(await exists('sources/wiki/Customers/Acme/Other.md')).toBe(true);
    expect(await exists('sources/wiki/README.md')).toBe(true);
  });

  it('fails readably and leaves no half clone', async () => {
    const r = await refreshMirror(
      git,
      dir,
      { ...wiki, gitUrl: path.join(tmp, 'nope') },
      ROOT,
      auth,
      pageUrl,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toBe('');
    expect(await exists('.mirror')).toBe(false);
  });

  it('sanitises page names so nothing escapes sources/wiki', async () => {
    await put('Customers/Acme/Second-brain/..%2F..%2Fescape.md', 'x\n');
    await put('Customers/Acme/Second-brain/A%2FB%3AC.md', 'y\n');
    const r = await refreshMirror(git, dir, wiki, ROOT, auth, pageUrl);
    expect(r).toMatchObject({ ok: true, added: 4, pages: 4 });
    expect(await exists('sources/wiki/Second brain/.._.._escape.md')).toBe(
      true,
    );
    expect(await exists('sources/wiki/Second brain/A_B_C.md')).toBe(true);
    expect(await exists('escape.md')).toBe(false);
    expect(await exists('sources/escape.md')).toBe(false);
  });

  it('follows a changed root page', async () => {
    await refreshMirror(git, dir, wiki, ROOT, auth, pageUrl);
    await put('Customers/Acme/Other/Child.md', 'c\n');
    const r = await refreshMirror(
      git,
      dir,
      { ...wiki, rootPath: '/Customers/Acme/Other' },
      '/Customers/Acme/Other.md',
      auth,
      pageUrl,
    );
    expect(r).toMatchObject({ ok: true, added: 2, removed: 2, pages: 2 });
    expect(await exists('sources/wiki/Other.md')).toBe(true);
    expect(await exists('sources/wiki/Other/Child.md')).toBe(true);
    expect(await exists('sources/wiki/Second brain.md')).toBe(false);
  });

  it('re-clones when the wiki url changes', async () => {
    await refreshMirror(git, dir, wiki, ROOT, auth, pageUrl);
    const other = makeRepo('wiki2');
    sh(other, 'checkout', '-q', '-b', 'wikiMaster');
    await fs.mkdir(path.join(other, 'Customers/Acme'), { recursive: true });
    commitFile(other, 'Customers/Acme/Second-brain.md', 'new\n');
    const r = await refreshMirror(
      git,
      dir,
      { ...wiki, gitUrl: other },
      ROOT,
      auth,
      pageUrl,
    );
    expect(r).toMatchObject({ ok: true, changed: 1, removed: 1, pages: 1 });
  });

  it('sparsePatterns for the wiki root and for a page', () => {
    expect(sparsePatterns({ ...wiki, rootPath: '/', mappedPath: '/' })).toEqual(
      ['/**'],
    );
    expect(
      sparsePatterns({ ...wiki, rootPath: '/', mappedPath: '/docs' }),
    ).toEqual(['/docs/**']);
    expect(sparsePatterns(wiki, ROOT)).toEqual([
      ROOT,
      '/Customers/Acme/Second-brain/**',
    ]);
    expect(sparsePatterns({ ...wiki, mappedPath: '/docs' }, ROOT)).toEqual([
      '/docs' + ROOT,
      '/docs/Customers/Acme/Second-brain/**',
    ]);
  });
});
