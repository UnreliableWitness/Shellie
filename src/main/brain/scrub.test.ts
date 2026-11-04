import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitClient } from '../services/GitClient';
import { scaffoldBrain } from './scaffold';
import { scrubBrain, scrubVariants } from './scrub';

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

  it('redacts the value and its encoded forms in text files, renames files, commits only those', async () => {
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
    await write(`sources/${secret.replace(/\//g, '_')}.md`, 'named\n');
    await write('log.md', `# Log\n\n- ${secret}\n`);
    await git.run(dir, ['add', '-A']);
    await git.run(dir, ['commit', '-q', '-m', 'Brain: sync']);
    await write('wiki/hand.md', 'edited by hand, not committed\n');

    const r = await scrubBrain(git, dir, secret);
    expect(r.files).toBe(4);
    expect(await read('sources/2026-11-04-notes.md')).toBe(
      'Use [REDACTED] here.\n',
    );
    expect(await read('sources/2026-11-04-notes.txt')).toBe(
      'url?p=[REDACTED]\n',
    );
    expect(await read('wiki/account.md')).toBe('b64 [REDACTED] end\n');
    expect(await read('log.md')).toBe('# Log\n\n- [REDACTED]\n');
    expect(await read('sources/pic.png')).toBe(secret);
    const subject = (await git.run(dir, ['log', '-1', '--format=%s'])).trim();
    expect(subject).toBe('Brain: scrub');
    // The hand edit stays uncommitted: the scrub commit holds only what it changed.
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
    expect(await scrubBrain(git, dir, secret)).toEqual({ files: 0 });
  });

  it('refuses a short value and renames a file named after the value', async () => {
    await expect(scrubBrain(git, dir, 'abc')).rejects.toThrow(/at least 6/);
    await write('sources/token-hunter2x-notes.md', 'x\n');
    await git.run(dir, ['add', '-A']);
    await git.run(dir, ['commit', '-q', '-m', 'Brain: sync']);
    expect(await scrubBrain(git, dir, 'hunter2x')).toEqual({ files: 1 });
    expect(await read('sources/token-redacted-notes.md')).toBe('x\n');
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('scrubVariants covers the written, URL-encoded and base64 forms', () => {
    expect(scrubVariants('a b/c')).toEqual(['a b/c', 'a%20b%2Fc']);
    expect(scrubVariants('plainvalue1')).toEqual([
      'plainvalue1',
      Buffer.from('plainvalue1').toString('base64'),
    ]);
  });
});
