import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrainSourceRow } from '../../shared/brain';
import { checkBrain, citedSources, localDay, localTarget } from './check';
import { parsePage, readPages } from './pages';

const row = (
  p: string,
  ingestedAt: string,
  captured = true,
): BrainSourceRow => ({
  path: p,
  type: 'doc',
  ingestedAt,
  captured,
  original: null,
  contents: null,
});

describe('localTarget', () => {
  it('resolves relative targets from the page folder and leaves URLs and fragments alone', () => {
    expect(localTarget('wiki/a.md', '../sources/x.md#p3')).toBe('sources/x.md');
    expect(localTarget('wiki/digests/w.md', '../account.md')).toBe(
      'wiki/account.md',
    );
    expect(localTarget('index.md', 'wiki/a.md')).toBe('wiki/a.md');
    expect(localTarget('wiki/a.md', '/sources/x.md')).toBe('sources/x.md');
    expect(localTarget('wiki/a.md', '../sources/My%20File.md')).toBe(
      'sources/My File.md',
    );
    expect(localTarget('wiki/a.md', 'https://x.example/p')).toBeNull();
    expect(localTarget('wiki/a.md', 'mailto:a@b.c')).toBeNull();
    expect(localTarget('wiki/a.md', '#top')).toBeNull();
    expect(localTarget('wiki/a.md', '')).toBeNull();
    // A broken escape is kept as written rather than thrown.
    expect(localTarget('wiki/a.md', 'x%ZZ.md')).toBe('wiki/x%ZZ.md');
  });
});

describe('citedSources', () => {
  it('joins frontmatter entries and links into sources/, deduplicated', () => {
    const p = parsePage(
      'wiki/a.md',
      '---\nsources: [sources/k.md, ../sources/d.md, wiki/other.md]\n---\n[a](../sources/k.md#p1) [b](../sources/e.md) [c](../sources/d-assets/p.png)\n',
    );
    expect(citedSources(p)).toEqual([
      'sources/k.md',
      'sources/d.md',
      'sources/e.md',
    ]);
  });
});

describe('checkBrain', () => {
  let dir: string;
  const now = new Date('2026-11-04T10:00:00Z');
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-check-'));
    await fs.mkdir(path.join(dir, 'wiki', 'digests'), { recursive: true });
    await fs.mkdir(path.join(dir, 'sources', 'wiki'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const write = (rel: string, text: string) =>
    fs.writeFile(path.join(dir, ...rel.split('/')), text);
  const run = async (sources: BrainSourceRow[], indexMd: string | null) =>
    checkBrain(
      { brainDir: dir, pages: await readPages(dir), sources, indexMd },
      now,
    );

  it('finds nothing wrong with a sound brain', async () => {
    await write('sources/2026-11-01-k.md', 'k');
    await write(
      'wiki/account.md',
      '---\ntitle: A\nsummary: S\nsources: [sources/2026-11-01-k.md]\nlast_updated: 2026-11-02\n---\n[k](../sources/2026-11-01-k.md#p2) [digest](digests/2026-w45.md)\n',
    );
    await write(
      'wiki/digests/2026-w45.md',
      '---\ntitle: W45\nsummary: Week\nlast_updated: 2026-11-02\n---\n[a](../account.md)\n',
    );
    const out = await run(
      [row('sources/2026-11-01-k.md', '2026-11-01T09:00:00Z')],
      '# Acme brain\n\n- [A](wiki/account.md): S\n',
    );
    expect(out).toEqual([]);
  });

  it('reports broken links in pages and in index.md, once per target, and leaves URLs alone', async () => {
    await write(
      'wiki/a.md',
      '---\ntitle: A\nsummary: S\nsources: [sources/x.md]\n---\n[1](gone.md) [2](gone.md#x) [3](https://x.example) [4](<../sources/No Such.md>)\n```\n[5](fenced.md)\n```\n',
    );
    const out = await run([], '# I\n\n- [A](wiki/a.md)\n- [B](wiki/b.md)\n');
    expect(out.map((f) => [f.kind, f.page, f.detail])).toEqual([
      ['broken-link', 'index.md', 'wiki/b.md does not exist'],
      ['broken-link', 'wiki/a.md', 'gone.md does not exist'],
      ['broken-link', 'wiki/a.md', '../sources/No Such.md does not exist'],
    ]);
    expect(out[0].at).toBe(now.toISOString());
  });

  it('reports a page updated before a source it cites, by day', async () => {
    await write(
      'wiki/a.md',
      '---\ntitle: A\nsummary: S\nsources: [sources/k.md]\nlast_updated: 2026-11-02\n---\n[d](../sources/d.md)\n',
    );
    await write('sources/k.md', 'k');
    await write('sources/d.md', 'd');
    const out = await run(
      [
        // Local noon, so the local day is the same in every time zone the test runs in.
        row('sources/k.md', new Date(2026, 10, 2, 12).toISOString()),
        row('sources/d.md', new Date(2026, 10, 3, 12).toISOString()),
      ],
      null,
    );
    expect(out).toEqual([
      {
        kind: 'stale',
        page: 'wiki/a.md',
        detail: 'updated 2026-11-02, cites sources/d.md ingested 2026-11-03',
        at: now.toISOString(),
      },
    ]);
  });

  it('reports frontmatter gaps, digests excepted for sources', async () => {
    await write('wiki/none.md', '# No frontmatter\n');
    await write('wiki/thin.md', '---\ntitle: T\n---\n');
    await write('wiki/digests/2026-w44.md', '---\ntitle: D\nsummary: S\n---\n');
    await write(
      'wiki/empty.md',
      '---\ntitle: E\nsummary: S\nsources: []\n---\n',
    );
    const out = await run([], null);
    expect(out.map((f) => [f.page, f.detail])).toEqual([
      ['wiki/empty.md', 'missing sources'],
      ['wiki/none.md', 'no frontmatter'],
      ['wiki/thin.md', 'missing summary, sources'],
    ]);
    expect(out.every((f) => f.kind === 'frontmatter')).toBe(true);
  });

  it('reports uncaptured sources outside the wiki mirror', async () => {
    const out = await run(
      [
        row('sources/a.md', '2026-11-01T00:00:00Z', false),
        row('sources/wiki/Page.md', '2026-11-01T00:00:00Z', false),
        row('sources/b.md', '2026-11-01T00:00:00Z', true),
      ],
      null,
    );
    expect(out).toEqual([
      {
        kind: 'uncaptured',
        page: 'sources/a.md',
        detail: 'not captured yet',
        at: now.toISOString(),
      },
    ]);
  });
});

describe('checkBrain after review', () => {
  let dir: string;
  const now = new Date('2026-11-04T10:00:00Z');
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-check2-'));
    await fs.mkdir(path.join(dir, 'wiki'), { recursive: true });
    await fs.mkdir(path.join(dir, 'sources'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const write = (rel: string, text: string) =>
    fs.writeFile(path.join(dir, ...rel.split('/')), text);
  const run = async (sources: BrainSourceRow[], inFlight?: string[]) =>
    checkBrain(
      {
        brainDir: dir,
        pages: await readPages(dir),
        sources,
        indexMd: null,
        inFlight,
      },
      now,
    );

  it('reports a link that points outside the brain without looking there', async () => {
    await write(
      'wiki/esc.md',
      '---\ntitle: E\nsummary: s\nsources: [sources/k.md]\n---\n[up](../../../../../../etc/hosts) [root](/etc/hosts)\n',
    );
    const out = await run([]);
    expect(out.map((f) => f.detail)).toEqual([
      '../../../../../../etc/hosts points outside the brain',
      '/etc/hosts does not exist',
    ]);
  });

  it('compares the local day of ingested_at and rejects last_updated that is not a date', async () => {
    const offset = -now.getTimezoneOffset();
    // Local midnight of 2026-11-04, as a UTC instant: same local day as the page.
    const localMidnight = new Date(
      Date.UTC(2026, 10, 4, 0, 0) - offset * 60_000,
    );
    await write(
      'wiki/a.md',
      '---\ntitle: A\nsummary: s\nsources: [sources/k.md]\nlast_updated: 2026-11-04\n---\n',
    );
    await write(
      'wiki/b.md',
      '---\ntitle: B\nsummary: s\nsources: [sources/k.md]\nlast_updated: 04/11/2026\n---\n',
    );
    await write(
      'wiki/c.md',
      '---\ntitle: C\nsummary: s\nsources: ["sources/c%20d.md#p1"]\nlast_updated: 2026-11-01\n---\n',
    );
    const out = await run([
      row('sources/k.md', localMidnight.toISOString()),
      row('sources/c d.md', new Date(2026, 10, 3, 12).toISOString()),
    ]);
    expect(out.map((f) => [f.kind, f.page, f.detail])).toEqual([
      [
        'frontmatter',
        'wiki/b.md',
        'last_updated is not a date (yyyy-mm-dd): 04/11/2026',
      ],
      [
        'stale',
        'wiki/c.md',
        'updated 2026-11-01, cites sources/c d.md ingested 2026-11-03',
      ],
    ]);
  });

  it('leaves out sources with a capture in flight', async () => {
    const out = await run(
      [
        row('sources/a.md', '2026-11-01T00:00:00Z', false),
        row('sources/b.md', '2026-11-01T00:00:00Z', false),
      ],
      ['sources/a.md'],
    );
    expect(out.map((f) => f.page)).toEqual(['sources/b.md']);
  });
});

describe('after the second review', () => {
  it('normalises backslashes before the outside-the-brain check and validates the day', () => {
    expect(localTarget('wiki/a.md', '..\\..\\..\\etc\\hosts')).toBe(
      '../../etc/hosts',
    );
    expect(localTarget('wiki/a.md', 'sub\\page.md')).toBe('wiki/sub/page.md');
    expect(localDay('2026-11-04')).toBe('2026-11-04');
    expect(localDay(new Date(2026, 10, 4, 23, 30).toISOString())).toBe(
      '2026-11-04',
    );
  });

  it('rejects an out-of-range last_updated', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-check3-'));
    try {
      await fs.mkdir(path.join(dir, 'wiki'));
      await fs.writeFile(
        path.join(dir, 'wiki', 'a.md'),
        '---\ntitle: A\nsummary: s\nsources: [sources/k.md]\nlast_updated: 2026-13-45\n---\n',
      );
      const out = await checkBrain({
        brainDir: dir,
        pages: await readPages(dir),
        sources: [],
        indexMd: null,
      });
      expect(out.map((f) => f.detail)).toEqual([
        'last_updated is not a date (yyyy-mm-dd): 2026-13-45',
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('confidence and verified', () => {
  let dir: string;
  const now = new Date('2026-11-04T10:00:00Z');
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-check4-'));
    await fs.mkdir(path.join(dir, 'wiki'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const write = (rel: string, text: string) =>
    fs.writeFile(path.join(dir, ...rel.split('/')), text);

  it('flags bad values and lets a verification cover a newer source', async () => {
    await write(
      'wiki/a.md',
      '---\ntitle: A\nsummary: s\nsources: [sources/k.md]\nlast_updated: 2026-11-01\nconfidence: maybe\nverified: soon\n---\n',
    );
    await write(
      'wiki/b.md',
      '---\ntitle: B\nsummary: s\nsources: [sources/k.md]\nlast_updated: 2026-11-01\nconfidence: high\nverified: 2026-11-03\n---\n',
    );
    await write(
      'wiki/c.md',
      '---\ntitle: C\nsummary: s\nsources: [sources/k.md]\nlast_updated: 2026-11-01\nverified: 2026-11-02\n---\n',
    );
    const out = await checkBrain(
      {
        brainDir: dir,
        pages: await readPages(dir),
        sources: [row('sources/k.md', new Date(2026, 10, 3, 12).toISOString())],
        indexMd: null,
      },
      now,
    );
    expect(out.map((f) => [f.kind, f.page, f.detail])).toEqual([
      [
        'frontmatter',
        'wiki/a.md',
        'confidence is not high, medium or low: maybe',
      ],
      ['frontmatter', 'wiki/a.md', 'verified is not a date (yyyy-mm-dd): soon'],
      [
        'stale',
        'wiki/a.md',
        'updated 2026-11-01, cites sources/k.md ingested 2026-11-03',
      ],
      [
        'stale',
        'wiki/c.md',
        'updated 2026-11-01, cites sources/k.md ingested 2026-11-03',
      ],
    ]);
  });
});
