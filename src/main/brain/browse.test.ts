import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  headingText,
  pageRows,
  pageType,
  relevantPages,
  searchBrain,
  snippet,
  taskWords,
} from './browse';

describe('pageType', () => {
  it('reads the type from the file name and the digests folder', () => {
    expect(pageType('wiki/account.md')).toBe('account');
    expect(pageType('wiki/scope-platform.md')).toBe('scope');
    expect(pageType('wiki/component-api.md')).toBe('component');
    expect(pageType('wiki/glossary.md')).toBe('glossary');
    expect(pageType('wiki/decision-2026-11-03-db.md')).toBe('decision');
    expect(pageType('wiki/meeting-2026-11-01-kickoff.md')).toBe('meeting');
    expect(pageType('wiki/lesson-2026-11-04-retries.md')).toBe('lesson');
    expect(pageType('wiki/digests/2026-w45.md')).toBe('digest');
    expect(pageType('wiki/notes.md')).toBe('other');
    expect(pageType('wiki/decisions/2026-11-03-db.md')).toBe('other');
  });
});

describe('pageRows and searchBrain', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-browse-'));
    await fs.mkdir(path.join(dir, 'wiki', 'digests'), { recursive: true });
    await fs.mkdir(path.join(dir, 'sources', 'deck-assets'), {
      recursive: true,
    });
    await fs.mkdir(path.join(dir, 'sources', 'wiki', '.attachments'), {
      recursive: true,
    });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const write = (rel: string, text: string) =>
    fs.writeFile(path.join(dir, ...rel.split('/')), text);

  it('builds rows with type order, backlinks, cited sources and verified state', async () => {
    await write(
      'wiki/meeting-2026-11-01-kickoff.md',
      '---\ntitle: Kickoff\nsummary: First meeting.\nsources: [sources/2026-11-01-k.md]\nlast_updated: 2026-11-02\nconfidence: medium\nverified: 2026-11-01\n---\n\n# Kickoff\n\nSee [account](account.md) and [scope](scope-platform.md).\n',
    );
    await write(
      'wiki/account.md',
      '---\ntitle: Acme\nsummary: Who they are.\nsources: [sources/2026-11-01-k.md]\nlast_updated: 2026-11-02\nconfidence: high\nverified: 2026-11-03\n---\n\n# Acme\n\n[scope](scope-platform.md) [self](account.md) [gone](nope.md)\n',
    );
    await write(
      'wiki/scope-platform.md',
      '---\ntitle: "Scope: platform"\nconfidence: maybe\nverified: soon\nlast_updated: yesterday\n---\n\n# Scope\n\nWhat we build, cited from [k](../sources/2026-11-01-k.md#p2).\n',
    );
    await write('wiki/digests/2026-w45.md', '---\ntitle: W45\n---\n');
    await write('wiki/empty.md', '---\ntitle: Empty\n---\n');
    const rows = await pageRows(dir);
    expect(rows.map((r) => [r.path, r.type])).toEqual([
      ['wiki/account.md', 'account'],
      ['wiki/scope-platform.md', 'scope'],
      ['wiki/meeting-2026-11-01-kickoff.md', 'meeting'],
      ['wiki/digests/2026-w45.md', 'digest'],
      ['wiki/empty.md', 'other'],
    ]);
    const account = rows[0];
    expect(account).toMatchObject({
      title: 'Acme',
      summary: 'Who they are.',
      confidence: 'high',
      verified: '2026-11-03',
      changedSinceVerified: false,
      sources: ['sources/2026-11-01-k.md'],
      linkedFrom: ['wiki/meeting-2026-11-01-kickoff.md'],
    });
    const scope = rows[1];
    expect(scope).toMatchObject({
      title: 'Scope: platform',
      summary: 'What we build, cited from k.',
      confidence: null,
      verified: null,
      lastUpdated: 'yesterday',
      sources: ['sources/2026-11-01-k.md'],
      linkedFrom: ['wiki/account.md', 'wiki/meeting-2026-11-01-kickoff.md'],
    });
    expect(rows[2]).toMatchObject({
      changedSinceVerified: true,
      confidence: 'medium',
      linkedFrom: [],
    });
    expect(rows[4].summary).toBe('');
  });

  it('searches pages then sources, outside the frontmatter, with anchors and caps', async () => {
    await write(
      'wiki/account.md',
      '---\ntitle: Acme\nsummary: Budget owner is the CFO.\n---\n\n# Acme\n\nIntro.\n\n## Budget\n\nThe budget is 100k.\nMore budget talk.\nEven more budget.\nAnd a fourth budget line.\n',
    );
    await write(
      'sources/2026-11-01-k.md',
      '---\ntitle: Kickoff deck\nsource_url: k.pptx\ningested_at: 2026-11-01T00:00:00.000Z\ncontent_type: deck\nsha256: x\n---\n\n## Slide 1\n\nBudget slide.\n\n## Slide 2\n\nNo match here. '.concat(
        'x'.repeat(200),
        ' budget at the far end',
      ),
    );
    await write('sources/deck-assets/budget.md', 'budget inside assets\n');
    await write(
      'sources/wiki/.attachments/budget.md',
      'budget inside attachments\n',
    );
    const hits = await searchBrain(dir, 'BUDGET');
    expect(hits.map((h) => [h.kind, h.path, h.line, h.anchor])).toEqual([
      // The heading itself matches, with its own anchor; then two lines under it (the per-file cap).
      ['page', 'wiki/account.md', 10, 'budget'],
      ['page', 'wiki/account.md', 12, 'budget'],
      ['page', 'wiki/account.md', 13, 'budget'],
      ['source', 'sources/2026-11-01-k.md', 11, 'slide-1'],
      ['source', 'sources/2026-11-01-k.md', 15, 'slide-2'],
    ]);
    expect(hits[0]).toMatchObject({ title: 'Acme', text: '## Budget' });
    expect(hits[1].text).toBe('The budget is 100k.');
    expect(hits[3].title).toBe('Kickoff deck');
    expect(hits[4].text.startsWith('…')).toBe(true);
    expect(hits[4].text.length).toBeLessThanOrEqual(162);
    expect(hits[4].text).toContain('budget at the far end');
    expect(await searchBrain(dir, 'b')).toEqual([]);
    expect(await searchBrain(dir, '  ')).toEqual([]);
  });

  it('snippet keeps a short line whole and cuts a long one around the match', () => {
    expect(snippet('  short line  ', 4)).toBe('short line');
    const long = `${'a'.repeat(100)}needle${'b'.repeat(100)}`;
    const s = snippet(long, 100);
    expect(s).toContain('needle');
    expect(s.length).toBeLessThanOrEqual(162);
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true);
  });
});

describe('relevance', () => {
  it('takes words of 4+ letters once, without stop words', () => {
    expect(
      taskWords([
        'Fix the Billing export for Acme',
        'billing export fix',
        'with THIS',
      ]),
    ).toEqual(['billing', 'export', 'acme']);
  });

  it('ranks pages by title words twice and summary words once, top 5', () => {
    const row = (path: string, title: string, summary: string) => ({
      path,
      title,
      summary,
      type: 'other' as const,
      lastUpdated: null,
      confidence: null,
      verified: null,
      changedSinceVerified: false,
      sources: [],
      linkedFrom: [],
    });
    const rows = [
      row('wiki/a.md', 'Billing', 'The export runs nightly.'),
      row('wiki/b.md', 'Export format', 'Billing fields.'),
      row('wiki/c.md', 'Unrelated', 'Nothing.'),
      row('wiki/d.md', 'Acme', 'Who they are.'),
      ...Array.from({ length: 6 }, (_, i) =>
        row(`wiki/e${i}.md`, `Note ${i}`, 'mentions acme'),
      ),
    ];
    const words = taskWords(['Billing export for Acme']);
    const top = relevantPages(rows, words);
    expect(top.slice(0, 3)).toEqual(['wiki/a.md', 'wiki/b.md', 'wiki/d.md']);
    expect(top).toHaveLength(5);
    expect(relevantPages(rows, [])).toEqual([]);
  });
});

describe('after review', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-browse2-'));
    await fs.mkdir(path.join(dir, 'wiki'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('gives a hit the anchor the viewer would, skipping fenced code and markdown in headings', async () => {
    await fs.writeFile(
      path.join(dir, 'wiki', 'a.md'),
      [
        '---',
        'title: A',
        '---',
        '# Top',
        '```',
        '# not a heading',
        'foo in fence',
        '```',
        '## The `api` [link](x) **bold**',
        'foo after',
        '## Top',
        'foo last',
      ].join('\n'),
    );
    const hits = await searchBrain(dir, 'foo');
    expect(hits.map((h) => [h.line, h.anchor])).toEqual([
      [7, 'top'],
      [10, 'the-api-link-bold'],
      [12, 'top-1'],
    ]);
    // As the viewer ids them: underscores inside words and code stay, a picture leaves its leading space.
    expect(headingText('`code` _em_ ~~x~~ **b**')).toBe('code em x b');
    expect(headingText('snake_case_name')).toBe('snake_case_name');
    expect(headingText('`a_b` call')).toBe('a_b call');
    expect(headingText('"quoted _x_"')).toBe('"quoted x"');
    expect(headingText('Q&A: _why_?')).toBe('Q&A: why?');
    expect(headingText('__init__ and snake__double')).toBe(
      'init and snake__double',
    );
    expect(headingText('_private')).toBe('_private');
    expect(headingText('trailing_')).toBe('trailing_');
    expect(headingText('(_x_) a _b_, c')).toBe('(x) a b, c');
    expect(headingText("it's _x_'s file_name.md")).toBe(
      "it's x's file_name.md",
    );
    expect(headingText('![pic](p.png) Diagram')).toBe(' Diagram');
    expect(headingText('The `api` [link](x) **bold**')).toBe(
      'The api link bold',
    );
  });

  it('normalises words and skips Dutch and German stop words', () => {
    expect(taskWords(['Größe Änderung', 'voor niet nicht eine'])).toEqual([
      'größe',
      'änderung',
    ]);
  });
});
