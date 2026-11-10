import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitClient } from '../services/GitClient';
import { brainHealth } from './health';
import { scaffoldBrain } from './scaffold';
import { OUTSIDE_EDIT_MESSAGE, scrubBrain, scrubVariants } from './scrub';
import { readState, writeState } from './state';

describe('scrubBrain', () => {
  const git = new GitClient();
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-scrub-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  };
  const read = (rel: string) => fs.readFile(path.join(dir, rel), 'utf8');
  const commit = async (message: string) => {
    await git.run(dir, ['add', '-A']);
    await git.run(dir, ['commit', '-q', '-m', message]);
  };
  const subjects = async (n: number) =>
    (await git.run(dir, ['log', `--format=%s`, `-${n}`])).trim().split('\n');

  it('redacts the value and its encoded forms in text files and commits only those', async () => {
    const secret = 'Sup3r/Secret+Value';
    await write('sources/2026-11-04-notes.md', `Use ${secret} here.\n`);
    await write(
      'sources/2026-11-04-notes.txt',
      `url?p=${encodeURIComponent(secret)}\n`,
    );
    await write(
      'wiki/account.md',
      `b64 ${Buffer.from(secret).toString('base64')} end\n`,
    );
    await write('wiki/clean.md', 'nothing here\n');
    await write('sources/pic.png', secret);
    await write('log.md', `# Log\n\n- ${secret}\n`);
    await commit('Brain: sync');
    await write('wiki/hand.md', 'edited by hand, not committed\n');

    const r = await scrubBrain(git, dir, secret);
    expect(r).toEqual({ files: 4, skipped: 0 });
    expect(await read('sources/2026-11-04-notes.md')).toBe(
      'Use REDACTED here.\n',
    );
    expect(await read('sources/2026-11-04-notes.txt')).toBe('url?p=REDACTED\n');
    expect(await read('wiki/account.md')).toBe('b64 REDACTED end\n');
    expect(await read('log.md')).toBe('# Log\n\n- REDACTED\n');
    expect(await read('sources/pic.png')).toBe(secret);
    expect(await subjects(1)).toEqual(['Brain: scrub']);
    // The hand edit of another file stays uncommitted: the scrub commit holds only what it changed.
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe(
      '?? wiki/hand.md',
    );
    // The commit message and the new tree never hold the value (history keeps the old text).
    expect(await git.run(dir, ['log', '-1', '--format=%B'])).not.toContain(
      secret,
    );
    await expect(
      git.run(dir, ['grep', '-F', '-e', secret, 'HEAD', '--', '*.md', '*.txt']),
    ).rejects.toThrow();
    expect(await scrubBrain(git, dir, secret)).toEqual({
      files: 0,
      skipped: 0,
    });
  });

  it('redacts the book: a page path and a chapter title', async () => {
    const secret = 'Sup3rSecretValue';
    await write(
      'brain/book.json',
      JSON.stringify({
        chapters: [{ title: `About ${secret}`, pages: [`wiki/${secret}.md`] }],
      }),
    );
    await commit('Brain: book');
    await scrubBrain(git, dir, secret);
    const book = await read('brain/book.json');
    expect(book).not.toContain(secret);
    expect(book).toContain('About REDACTED');
  });

  it('redacts what was asked and decided in brain/conflicts.json', async () => {
    const secret = 'Sup3rSecretValue';
    await write(
      'brain/conflicts.json',
      JSON.stringify({
        version: 1,
        conflicts: { c: { parked: { question: `Ask ${secret}?`, at: 'now' } } },
      }),
    );
    await commit('Brain: park conflict');
    await scrubBrain(git, dir, secret);
    const f = await read('brain/conflicts.json');
    expect(f).not.toContain(secret);
    expect(f).toContain('Ask REDACTED?');
  });

  it("saves a person's uncommitted wiki edit as an outside edit before redacting it", async () => {
    const secret = 'hunter2x!';
    await write('wiki/h.md', 'committed\n');
    await write('wiki/other.md', 'other\n');
    await commit('Brain: sync');
    await write('wiki/h.md', `committed\nhand-added ${secret}\n`);
    await write('wiki/newpage.md', `new page with ${secret}\n`);
    await write('wiki/other.md', 'other, edited by hand\n');
    expect(await scrubBrain(git, dir, secret)).toEqual({
      files: 2,
      skipped: 0,
    });
    expect(await subjects(2)).toEqual(['Brain: scrub', OUTSIDE_EDIT_MESSAGE]);
    expect(await read('wiki/h.md')).toBe('committed\nhand-added REDACTED\n');
    expect(await read('wiki/newpage.md')).toBe('new page with REDACTED\n');
    const h = await brainHealth(dir, git, { tokens: 0, costEur: 0 }, false);
    expect(h.outsideEdits).toEqual([
      'wiki/h.md',
      'wiki/newpage.md',
      'wiki/other.md',
    ]);
  });

  it('renames every file and folder named after the value with the same token the text gets', async () => {
    const secret = 'topsecret9';
    const stem = `sources/2026-11-04-${secret}`;
    await write(
      `${stem}.md`,
      `# Notes\n\n![p](${stem.slice(8)}-assets/p.png)\n`,
    );
    await write(`${stem}.pdf`, 'binary');
    await write(`${stem}-assets/p.png`, 'png');
    await write(
      'wiki/account.md',
      `---\ntitle: A\nsources: [${stem}.md]\n---\nSee [n](../${stem}.md).\n`,
    );
    await writeState(dir, (s) => ({
      ...s,
      captured: { [`${stem}.md`]: { at: 't', sessionId: null } },
    }));
    await commit('Brain: sync');
    expect(await scrubBrain(git, dir, secret)).toEqual({
      files: 5,
      skipped: 0,
    });
    const renamed = 'sources/2026-11-04-REDACTED';
    expect(await read(`${renamed}.md`)).toBe(
      '# Notes\n\n![p](2026-11-04-REDACTED-assets/p.png)\n',
    );
    expect(await read(`${renamed}.pdf`)).toBe('binary');
    expect(await read(`${renamed}-assets/p.png`)).toBe('png');
    expect(await read('wiki/account.md')).toContain(`sources: [${renamed}.md]`);
    expect(Object.keys((await readState(dir)).state?.captured ?? {})).toEqual([
      `${renamed}.md`,
    ]);
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
    expect(await git.run(dir, ['ls-files'])).not.toContain(secret);
  });

  it('never overwrites on a rename, stages never-committed files, counts files too large to scan', async () => {
    const secret = 'collide999';
    await write('wiki/x-redacted.md', 'precious\n');
    await commit('Brain: sync');
    await write(`wiki/x-${secret}.md`, 'first\n');
    await write('wiki/precious.md', `holds ${secret}\n`);
    await fs.rename(
      path.join(dir, 'wiki', 'x-redacted.md'),
      path.join(dir, 'wiki', 'x-REDACTED.md'),
    );
    await commit('Brain: sync');
    expect(await scrubBrain(git, dir, secret)).toEqual({
      files: 2,
      skipped: 0,
    });
    expect(await read('wiki/x-REDACTED.md')).toBe('precious\n');
    expect(await read('wiki/x-REDACTED-2.md')).toBe('first\n');
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
    await write('sources/big.vtt', `${'a'.repeat(21 * 1024 * 1024)} ${secret}`);
    expect(await scrubBrain(git, dir, secret)).toEqual({
      files: 0,
      skipped: 1,
    });
  });

  it('refuses a short value', async () => {
    await expect(scrubBrain(git, dir, 'abc')).rejects.toThrow(/at least 6/);
  });

  it('scrubVariants covers the written, URL-encoded and base64 forms', () => {
    expect(scrubVariants('a b/c')).toEqual(['a b/c', 'a%20b%2Fc']);
    expect(scrubVariants('plainvalue1')).toEqual([
      'plainvalue1',
      Buffer.from('plainvalue1').toString('base64'),
    ]);
  });
});

describe('scrubBrain after the second review', () => {
  const git = new GitClient();
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-scrub2-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  };
  const commit = async (message: string) => {
    await git.run(dir, ['add', '-A']);
    await git.run(dir, ['commit', '-q', '-m', message]);
  };

  it('never sweeps an unrelated file in through a glob, keeps a dirty file inside a renamed folder an outside edit, and leaves a name already redacted alone', async () => {
    const secret = 'hunter2hunter2';
    await write(`wiki/${secret}dir/inner.md`, 'committed\n');
    await write('wiki/other.md', 'other\n');
    await write('wiki/REDACTEDx.md', 'already\n');
    await commit('Brain: sync');
    await write(`wiki/${secret}dir/inner.md`, `edited by hand ${secret}\n`);
    await write('sources/2026-11-04-D.md', 'unrelated, never committed\n');
    await write(`sources/2026-11-04-${secret}.md`, 'x\n');
    await scrubBrain(git, dir, secret);
    expect(
      await fs.readFile(
        path.join(dir, 'wiki', 'REDACTEDdir', 'inner.md'),
        'utf8',
      ),
    ).toBe('edited by hand REDACTED\n');
    const h = await brainHealth(dir, git, { tokens: 0, costEur: 0 }, false);
    expect(h.outsideEdits).toContain('wiki/REDACTEDdir/inner.md');
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe(
      '?? sources/2026-11-04-D.md',
    );
    expect(await fs.readdir(path.join(dir, 'wiki'))).toContain('REDACTEDx.md');
    expect(await fs.readdir(path.join(dir, 'wiki'))).not.toContain(
      'REDACTEDx-2.md',
    );
  });
});

describe('scrubBrain with non-ASCII names and deep dirty files', () => {
  const git = new GitClient();
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-scrub3-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  };
  const commit = async (message: string) => {
    await git.run(dir, ['add', '-A']);
    await git.run(dir, ['commit', '-q', '-m', message]);
  };

  it('renames and rewrites a committed page with a space and an accent, and keeps a dirty one an outside edit', async () => {
    const secret = 'secretvalue1';
    await write(`wiki/café ${secret}.md`, `holds ${secret}\n`);
    await write('wiki/naïve page.md', 'committed\n');
    await commit('Brain: sync');
    await write('wiki/naïve page.md', `edited ${secret}\n`);
    expect(await scrubBrain(git, dir, secret)).toEqual({
      files: 2,
      skipped: 0,
    });
    expect(
      await fs.readFile(path.join(dir, 'wiki', 'café REDACTED.md'), 'utf8'),
    ).toBe('holds REDACTED\n');
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
    const h = await brainHealth(dir, git, { tokens: 0, costEur: 0 }, false);
    expect(h.outsideEdits).toEqual(['wiki/naïve page.md']);
  });

  it('keeps a dirty file without the value, deep inside a renamed folder, an outside edit', async () => {
    const secret = 'hunter2hunter2';
    await write(`wiki/${secret}dir/sub/deep.md`, 'committed\n');
    await commit('Brain: sync');
    await write(`wiki/${secret}dir/sub/deep.md`, 'edited by hand, no value\n');
    await scrubBrain(git, dir, secret);
    const h = await brainHealth(dir, git, { tokens: 0, costEur: 0 }, false);
    expect(h.outsideEdits).toContain('wiki/REDACTEDdir/sub/deep.md');
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
  });
});
