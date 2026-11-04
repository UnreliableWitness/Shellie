import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexIntro, linkPath, rebuildIndex, renderIndex } from './indexPage';
import { parsePage } from './pages';

const page = (rel: string, fm: string, body = '') =>
  parsePage(`wiki/${rel}`, `---\n${fm}\n---\n\n${body}`);

describe('renderIndex', () => {
  it('lists top-level pages by type then name, dated ones newest first, and subfolders in sections', () => {
    const pages = [
      page('meeting-2026-11-01-kickoff.md', 'title: Kickoff\nsummary: First.'),
      page(
        'scope-platform.md',
        'title: "Scope: platform"\nsummary: What we build.',
      ),
      page('digests/2026-w44.md', 'title: W44\nsummary: Week 44.'),
      page('glossary.md', 'title: Glossary\nsummary: Terms.'),
      page('decision-2026-11-03-db.md', 'title: DB\nsummary: Postgres.'),
      page('digests/2026-w45.md', 'title: W45\nsummary: Week 45.'),
      page('account.md', 'title: Acme\nsummary: Who they are.'),
      page('meeting-2026-11-03-demo.md', 'title: Demo\nsummary: Second.'),
      page('component-api.md', 'title: API\nsummary: The API.'),
      page('notes.md', 'title: Notes\nsummary: Loose.'),
      page('decision-2026-11-02-cloud.md', 'title: Cloud\nsummary: Azure.'),
    ];
    expect(renderIndex('Acme brain', [], pages)).toBe(
      [
        '# Acme brain',
        '',
        '- [Acme](wiki/account.md): Who they are.',
        '- [Scope: platform](wiki/scope-platform.md): What we build.',
        '- [API](wiki/component-api.md): The API.',
        '- [Glossary](wiki/glossary.md): Terms.',
        '- [DB](wiki/decision-2026-11-03-db.md): Postgres.',
        '- [Cloud](wiki/decision-2026-11-02-cloud.md): Azure.',
        '- [Demo](wiki/meeting-2026-11-03-demo.md): Second.',
        '- [Kickoff](wiki/meeting-2026-11-01-kickoff.md): First.',
        '- [Notes](wiki/notes.md): Loose.',
        '',
        '## digests',
        '',
        '- [W45](wiki/digests/2026-w45.md): Week 45.',
        '- [W44](wiki/digests/2026-w44.md): Week 44.',
        '',
      ].join('\n'),
    );
  });

  it('falls back to the heading, the file name and the first line, one line each, clipped', () => {
    const long = 'x'.repeat(200);
    const pages = [
      page(
        'a.md',
        'last_updated: 2026-11-01',
        '# From heading\n\nFirst\nline.\n',
      ),
      parsePage('wiki/b-name.md', 'no frontmatter at all\n'),
      page('c.md', `title: "Multi\\n  line [t]"\nsummary: "${long}"`),
    ];
    const out = renderIndex('T', [], pages);
    expect(out).toContain('- [From heading](wiki/a.md): First');
    expect(out).toContain('- [b-name](wiki/b-name.md): no frontmatter at all');
    expect(out).toContain(`- [Multi line t](wiki/c.md): ${'x'.repeat(159)}…`);
  });

  it('keeps an intro and says when there are no pages', () => {
    expect(renderIndex('T', ['Welcome.', '', 'Two lines.'], [])).toBe(
      '# T\n\nWelcome.\n\nTwo lines.\n\n(no pages yet)\n',
    );
  });
});

describe('indexIntro', () => {
  it('keeps the title and the text before the first list item or section', () => {
    expect(
      indexIntro(
        '# Acme brain\n\nWelcome to the brain.\n\n- [A](wiki/a.md): old\n\n## Old section\n',
      ),
    ).toEqual({ title: 'Acme brain', intro: ['Welcome to the brain.'] });
    expect(indexIntro('# T\n\n(no pages yet)\n')).toEqual({
      title: 'T',
      intro: [],
    });
    expect(indexIntro('no heading\n- x')).toEqual({ title: null, intro: [] });
    expect(indexIntro(null)).toEqual({ title: null, intro: [] });
  });
});

describe('rebuildIndex', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-index-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const read = () => fs.readFile(path.join(dir, 'index.md'), 'utf8');

  it('writes index.md from the pages, keeps the old intro, and is idempotent', async () => {
    await fs.mkdir(path.join(dir, 'wiki'));
    await fs.writeFile(
      path.join(dir, 'index.md'),
      '# Acme brain\n\nIntro kept.\n\n- [Stale](wiki/gone.md): old\n',
    );
    await fs.writeFile(
      path.join(dir, 'wiki', 'account.md'),
      '---\ntitle: Acme\nsummary: Who.\n---\n',
    );
    expect(await rebuildIndex(dir, 'Other')).toBe(true);
    expect(await read()).toBe(
      '# Acme brain\n\nIntro kept.\n\n- [Acme](wiki/account.md): Who.\n',
    );
    expect(await rebuildIndex(dir, 'Other')).toBe(false);
  });

  it('creates a missing index.md with the brain name, and leaves a brain without wiki/ alone', async () => {
    expect(await rebuildIndex(dir, 'Acme')).toBe(false);
    await expect(read()).rejects.toThrow();
    await fs.mkdir(path.join(dir, 'wiki'));
    expect(await rebuildIndex(dir, 'Acme')).toBe(true);
    expect(await read()).toBe('# Acme brain\n\n(no pages yet)\n');
  });

  it('treats a CRLF index.md with the same content as current', async () => {
    await fs.mkdir(path.join(dir, 'wiki'));
    await fs.writeFile(
      path.join(dir, 'index.md'),
      '# T\r\n\r\n(no pages yet)\r\n',
    );
    expect(await rebuildIndex(dir, 'T')).toBe(false);
  });
});

describe('renderIndex after review', () => {
  it('reduces links in titles and summaries to text and drops brackets and backslashes', () => {
    const pages = [
      page(
        'account.md',
        'title: "Acme [x\\\\]"\nsummary: "See [scope](scope-a.md) and ![pic](../sources/d-assets/p.png)."',
      ),
      page(
        'scope-a.md',
        'title: S',
        'Agreed in the [kickoff](../sources/k.md#p3).\n',
      ),
    ];
    const out = renderIndex('T', [], pages);
    expect(out).toContain('- [Acme x](wiki/account.md): See scope and pic.');
    expect(out).toContain('- [S](wiki/scope-a.md): Agreed in the kickoff.');
    expect(out).not.toContain('](scope-a.md)');
  });

  it('encodes link paths the checker and markdown can read', () => {
    const pages = [
      page('c#1.md', 'title: C\nsummary: s'),
      page('q?.md', 'title: Q\nsummary: s'),
      page('Meeting notes.md', 'title: M\nsummary: s'),
      page('a(b.md', 'title: A\nsummary: s'),
      page('100%.md', 'title: P\nsummary: s'),
    ];
    const out = renderIndex('T', [], pages);
    expect(out).toContain('(wiki/c%231.md)');
    expect(out).toContain('(wiki/q%3F.md)');
    expect(out).toContain('(<wiki/Meeting notes.md>)');
    expect(out).toContain('(<wiki/a(b.md>)');
    expect(out).toContain('(wiki/100%25.md)');
    expect(linkPath('wiki/<x>.md')).toBe('wiki/%3Cx%3E.md');
  });

  it('indexIntro stops at numbered lists, tables, any heading and links into wiki/', () => {
    expect(
      indexIntro(
        '# T\n\nIntro.\n\n1. [A](wiki/a.md): n\n\n### Scope\n- [Old](wiki/gone.md)\n',
      ).intro,
    ).toEqual(['Intro.']);
    expect(indexIntro('# T\n\n| [A](wiki/a.md) | s |\n').intro).toEqual([]);
    expect(indexIntro('# T\n\nSee [A](wiki/a.md) first.\n').intro).toEqual([]);
    expect(indexIntro('# T\n\n+ item\n').intro).toEqual([]);
  });
});

describe('summaries after the second review', () => {
  it('reduces links with parentheses in the target and reference links to text', () => {
    const p = page(
      'a.md',
      'title: A\nsummary: "See [f](f(1).md) and [r][ref]."',
    );
    expect(renderIndex('T', [], [p])).toContain(
      '- [A](wiki/a.md): See f and r.',
    );
  });
});
