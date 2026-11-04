import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkTargets, parsePage, readPages, splitFrontmatter } from './pages';

describe('parsePage', () => {
  it('reads the frontmatter fields the checks and the index need', () => {
    const p = parsePage(
      'wiki/account.md',
      [
        '---',
        'title: Acme',
        'summary: Who Acme is.',
        'sources: [sources/2026-11-01-kickoff.md, "../sources/2026-11-02-deck.md"]',
        'last_updated: 2026-11-03',
        '---',
        '',
        '# Acme',
        '',
        'Who Acme is.',
        '',
        'See [the kickoff](../sources/2026-11-01-kickoff.md#p3) and [scope](scope-platform.md).',
        '![Org chart](../sources/2026-11-02-deck-assets/slide-2.png)',
      ].join('\n'),
    );
    expect(p).toMatchObject({
      path: 'wiki/account.md',
      hasFrontmatter: true,
      title: 'Acme',
      summary: 'Who Acme is.',
      sources: [
        'sources/2026-11-01-kickoff.md',
        '../sources/2026-11-02-deck.md',
      ],
      heading: 'Acme',
      firstLine: 'Who Acme is.',
      links: [
        '../sources/2026-11-01-kickoff.md#p3',
        'scope-platform.md',
        '../sources/2026-11-02-deck-assets/slide-2.png',
      ],
    });
    // The yaml package parses a bare date to a Date: the day is kept.
    expect(p.lastUpdated?.slice(0, 10)).toBe('2026-11-03');
  });

  it('is tolerant: no frontmatter, broken YAML, a string sources field, a quoted date', () => {
    expect(parsePage('wiki/a.md', '# A\n\nBody\n')).toMatchObject({
      hasFrontmatter: false,
      title: null,
      summary: null,
      sources: null,
      heading: 'A',
      firstLine: 'Body',
    });
    expect(
      parsePage('wiki/a.md', '---\ntitle: [unclosed\n---\n\n# A\n'),
    ).toMatchObject({ hasFrontmatter: false, heading: 'A' });
    expect(
      parsePage(
        'wiki/a.md',
        '---\ntitle: A\nsources: sources/x.md\nlast_updated: "2026-11-03"\n---\n',
      ),
    ).toMatchObject({ sources: ['sources/x.md'], lastUpdated: '2026-11-03' });
    expect(
      parsePage('wiki/a.md', '---\ntitle: A\nsources: []\nsummary: ""\n---\n'),
    ).toMatchObject({ sources: [], summary: null });
  });

  it('skips links in fenced code and inline code, and reads angle-bracket targets', () => {
    const text = [
      '```',
      '[not a link](nowhere.md)',
      '```',
      'Code `[x](inline.md)` here.',
      '[Spaces](<../sources/My File.md>) and [paren](a_(b).md "title")',
      '~~~',
      '[tilde](nope.md)',
      '~~~',
    ].join('\n');
    expect(linkTargets(text)).toEqual(['../sources/My File.md', 'a_(b).md']);
  });

  it('splitFrontmatter keeps the body after the block', () => {
    expect(splitFrontmatter('---\r\na: 1\r\n---\r\nbody\r\n')).toEqual({
      data: { a: 1 },
      body: 'body\r\n',
    });
    expect(splitFrontmatter('plain')).toEqual({ data: null, body: 'plain' });
  });
});

describe('readPages', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-pages-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('walks wiki/ recursively, sorted, skipping dot files and non-markdown', async () => {
    await fs.mkdir(path.join(dir, 'wiki', 'digests'), { recursive: true });
    await fs.writeFile(path.join(dir, 'wiki', '.gitkeep'), '');
    await fs.writeFile(path.join(dir, 'wiki', 'b.md'), '---\ntitle: B\n---\n');
    await fs.writeFile(path.join(dir, 'wiki', 'a.md'), '# A\n');
    await fs.writeFile(path.join(dir, 'wiki', 'pic.png'), 'x');
    await fs.writeFile(
      path.join(dir, 'wiki', 'digests', '2026-w45.md'),
      '---\ntitle: W45\n---\n',
    );
    expect((await readPages(dir)).map((p) => p.path)).toEqual([
      'wiki/a.md',
      'wiki/b.md',
      'wiki/digests/2026-w45.md',
    ]);
    expect(await readPages(path.join(dir, 'none'))).toEqual([]);
  });
});
