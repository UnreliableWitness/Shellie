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

  it('reads bare targets with spaces, apart from a quoted title', () => {
    expect(
      linkTargets(
        '[d](/sources/a b-assets/p4-1.png) ![e](x y.png "a title") [f](a (b) c.md \'t\') [g]()',
      ),
    ).toEqual(['/sources/a b-assets/p4-1.png', 'x y.png', 'a (b) c.md']);
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

describe('fences and dates after review', () => {
  it('closes a fence only with its own marker', () => {
    const text =
      '```\n~~~\n[a](in-backticks.md)\n```\n[b](after.md)\n~~~\n[c](in-tilde.md)\n~~~\n';
    expect(linkTargets(text)).toEqual(['after.md']);
  });

  it('keeps the written day of a bare date and the local day of a timestamp', () => {
    expect(
      parsePage('wiki/a.md', '---\nlast_updated: 2026-11-03\n---\n')
        .lastUpdated,
    ).toBe('2026-11-03');
    const local = new Date(2026, 10, 3, 23, 30);
    const iso = local.toISOString();
    expect(
      parsePage('wiki/a.md', `---\nlast_updated: ${iso}\n---\n`).lastUpdated,
    ).toBe('2026-11-03');
  });
});

describe('fences after the second review', () => {
  it('closes a fence only with a marker at least as long and bare', () => {
    expect(linkTargets('````\n```\n[in](a.md)\n````\n[out](b.md)\n')).toEqual([
      'b.md',
    ]);
    expect(
      linkTargets('```\n[in](a.md)\n```js\n[in2](c.md)\n```\n[out](b.md)\n'),
    ).toEqual(['b.md']);
    expect(linkTargets('```\n[in](a.md)\n```   \n[out](b.md)\n')).toEqual([
      'b.md',
    ]);
  });
});

describe('confidence and verified fields', () => {
  it('are read as written, a bare verified date kept as its day', () => {
    const p = parsePage(
      'wiki/a.md',
      '---\ntitle: A\nconfidence: low\nverified: 2026-11-02\n---\n',
    );
    expect(p.confidence).toBe('low');
    expect(p.verified).toBe('2026-11-02');
    expect(parsePage('wiki/a.md', '---\ntitle: A\n---\n')).toMatchObject({
      confidence: null,
      verified: null,
    });
  });
});
