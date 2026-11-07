import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrainSourceRow } from '../../shared/brain';
import { readPages } from './pages';
import {
  assetsOf,
  brainCoverage,
  coverage,
  MIRROR_SOURCE,
  pictureFindings,
  pictureLabel,
  readDropped,
  readSkipped,
  writeDropped,
  type DroppedFile,
  type SkippedFile,
} from './pictures';

const SOURCE = 'sources/2026-11-04-deck.md';
const ASSETS = 'sources/2026-11-04-deck-assets';

const row = (p: string): BrainSourceRow => ({
  path: p,
  type: 'deck',
  ingestedAt: '2026-11-04T10:00:00Z',
  captured: true,
  original: null,
  contents: null,
  note: null,
});

describe('pictures', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-pictures-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const write = async (rel: string, text: string) => {
    const file = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  const run = async (
    assets: string[],
    opts: {
      source?: string;
      sourceText?: string;
      skipped?: SkippedFile;
      dropped?: DroppedFile;
    } = {},
  ) =>
    coverage({
      source: opts.source ?? SOURCE,
      assets,
      sourceText: opts.sourceText ?? '',
      pages: await readPages(dir),
      skipped: opts.skipped ?? {},
      dropped: opts.dropped ?? {},
    });

  it('counts a picture linked from a page as described, with the page', async () => {
    await write(
      'wiki/arch.md',
      `See the [diagram](../${ASSETS}/slide-4-1.png).\n`,
    );
    const r = await run([`${ASSETS}/slide-4-1.png`, `${ASSETS}/slide-5-1.png`]);
    expect(r.source).toBe(SOURCE);
    expect(r.rows[0]).toMatchObject({
      path: `${ASSETS}/slide-4-1.png`,
      status: 'described',
      pages: ['wiki/arch.md'],
    });
    expect(r.rows[1]).toMatchObject({ status: 'missing', pages: [] });
    expect(r.counts).toMatchObject({ total: 2, described: 1, missing: 1 });
  });

  it('resolves encoded, absolute and deeper links', async () => {
    await write(
      'wiki/sub/x.md',
      '![d](../../sources/a%20b-assets/p3-1.png "t")\n',
    );
    await write('wiki/y.md', '[d](</sources/a b-assets/p4-1.png>)\n');
    const r = await run(
      ['sources/a b-assets/p3-1.png', 'sources/a b-assets/p4-1.png'],
      { source: 'sources/a b.md' },
    );
    expect(r.rows.map((x) => [x.status, x.pages])).toEqual([
      ['described', ['wiki/sub/x.md']],
      ['described', ['wiki/y.md']],
    ]);
  });

  it('does not count a slide anchor', async () => {
    await write('wiki/arch.md', `[Deck slide 4](../${SOURCE}#slide-4)\n`);
    const r = await run([`${ASSETS}/slide-4-1.png`]);
    expect(r.rows[0].status).toBe('missing');
  });

  it('marks a skipped picture with its reason, and described wins over skipped', async () => {
    await write('wiki/arch.md', `![x](../${ASSETS}/slide-2-1.png)\n`);
    const skipped: SkippedFile = {
      [`${ASSETS}/slide-1-1.png`]: { reason: 'company logo', at: 'x' },
      [`${ASSETS}/slide-2-1.png`]: { reason: 'stock photo', at: 'x' },
    };
    const r = await run(
      [`${ASSETS}/slide-1-1.png`, `${ASSETS}/slide-2-1.png`],
      {
        skipped,
      },
    );
    expect(r.rows[0]).toMatchObject({
      status: 'skipped',
      reason: 'company logo',
    });
    expect(r.rows[1]).toMatchObject({ status: 'described', reason: null });
    expect(r.counts).toMatchObject({ described: 1, skipped: 1, missing: 0 });
  });

  it('ignores a skipped entry whose file is gone and a bad skipped file', async () => {
    const r = await run([], {
      skipped: { [`${ASSETS}/gone.png`]: { reason: 'logo', at: 'x' } },
    });
    expect(r.rows).toEqual([]);
    expect(r.counts.total).toBe(0);

    await write('brain/pictures-skipped.json', '{not json');
    expect(await readSkipped(dir)).toEqual({});
    await write('brain/pictures-skipped.json', '{"a":{"at":"x"}}');
    expect(await readSkipped(dir)).toEqual({});
    await write(
      'brain/pictures-skipped.json',
      '{"a":{"reason":"logo","at":"x"},"b":3,"c":{"reason":""}}',
    );
    expect(await readSkipped(dir)).toEqual({ a: { reason: 'logo', at: 'x' } });
    expect(await readSkipped(path.join(dir, 'nowhere'))).toEqual({});
  });

  it('lists drops, accepted ones apart, and counts tiny images', async () => {
    const dropped: DroppedFile = {
      [SOURCE]: {
        dropped: [
          {
            where: 'slide 9, picture 2',
            reason: 'EMF converts on Windows only',
            fix: 'Re-add the deck on Windows',
            accepted: null,
          },
          {
            where: 'slide 10, picture 1',
            reason: 'over the 60 picture cap',
            fix: 'Split the deck',
            accepted: '2026-11-07T10:00:00Z',
          },
        ],
        tiny: 23,
      },
    };
    const r = await run([], { dropped });
    expect(r.counts).toEqual({
      total: 2,
      described: 0,
      skipped: 0,
      missing: 0,
      dropped: 1,
      accepted: 1,
      tiny: 23,
    });
    expect(r.rows).toEqual([
      {
        path: null,
        label: 'Slide 9, picture 2',
        alt: null,
        status: 'dropped',
        pages: [],
        reason: 'EMF converts on Windows only',
        fix: 'Re-add the deck on Windows',
        where: 'slide 9, picture 2',
      },
      expect.objectContaining({
        path: null,
        status: 'accepted',
        where: 'slide 10, picture 1',
      }),
    ]);
  });

  it('reads and writes the dropped file tolerantly', async () => {
    await write('brain/pictures-dropped.json', '[1]');
    expect(await readDropped(dir)).toEqual({});
    await write(
      'brain/pictures-dropped.json',
      JSON.stringify({
        a: {
          dropped: [
            { where: 'p 2', reason: 'r', fix: 'f', accepted: null },
            { where: 'p 3', reason: 'r' },
          ],
          tiny: 'x',
        },
        b: 'nope',
      }),
    );
    expect(await readDropped(dir)).toEqual({
      a: {
        dropped: [{ where: 'p 2', reason: 'r', fix: 'f', accepted: null }],
        tiny: 0,
      },
    });
    await writeDropped(dir, (f) => ({
      ...f,
      c: { dropped: [], tiny: 4 },
    }));
    const text = await fs.readFile(
      path.join(dir, 'brain', 'pictures-dropped.json'),
      'utf8',
    );
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "c": {');
    expect(Object.keys(await readDropped(dir))).toEqual(['a', 'c']);
  });

  it('labels pictures from their file names', () => {
    expect(pictureLabel(`${ASSETS}/slide-4-1.png`)).toBe('Slide 4');
    expect(pictureLabel(`${ASSETS}/p3.png`)).toBe('Page 3');
    expect(pictureLabel(`${ASSETS}/p3-2.png`)).toBe('Page 3');
    expect(pictureLabel(`${ASSETS}/layout-1.png`)).toBe(
      'Slide layouts and master',
    );
    expect(pictureLabel(`${ASSETS}/image-2.jpg`)).toBe('Picture 2');
    expect(pictureLabel(`${ASSETS}/sheet-2-1.png`)).toBe('Sheet 2');
    expect(pictureLabel('sources/wiki/.attachments/image-2.png')).toBe(
      'Wiki attachment',
    );
    expect(pictureLabel(`${ASSETS}/odd name.png`)).toBe('odd name.png');
  });

  it('takes the alt text from the source', async () => {
    const r = await run(
      [`${ASSETS}/slide-4-1.png`, `${ASSETS}/slide-5-1.png`],
      {
        sourceText:
          '## Slide 4\n\n![Integration architecture](2026-11-04-deck-assets/slide-4-1.png)\n\n![](2026-11-04-deck-assets/slide-5-1.png)\n',
      },
    );
    expect(r.rows[0]).toMatchObject({
      label: 'Slide 4',
      alt: 'Integration architecture',
    });
    expect(r.rows[1].alt).toBeNull();
  });

  it('one finding per source with gaps, none for accepted drops or tiny images', async () => {
    const drop = (accepted: string | null) => ({
      where: 'w',
      reason: 'r',
      fix: 'f',
      accepted,
    });
    const gaps = await run([`${ASSETS}/slide-4-1.png`], {
      dropped: { [SOURCE]: { dropped: [drop(null), drop(null)], tiny: 0 } },
    });
    const quiet = await run([], {
      source: 'sources/b.md',
      dropped: {
        'sources/b.md': { dropped: [drop('2026-11-07T10:00:00Z')], tiny: 23 },
      },
    });
    expect(pictureFindings([gaps, quiet], 'now')).toEqual([
      {
        kind: 'picture',
        page: SOURCE,
        detail: '1 picture not interpreted · 2 never reached Claude',
        at: 'now',
      },
    ]);
    const two = await run([
      `${ASSETS}/slide-4-1.png`,
      `${ASSETS}/slide-5-1.png`,
    ]);
    expect(pictureFindings([two], 'now')[0].detail).toBe(
      '2 pictures not interpreted',
    );
  });

  it('lists assets and covers every source with pictures or drops, and the mirror', async () => {
    await write(`${ASSETS}/slide-2-1.png`, 'x');
    await write(`${ASSETS}/slide-10-1.png`, 'x');
    await write(`${ASSETS}/.DS_Store`, 'x');
    await write(SOURCE, '![Logo](2026-11-04-deck-assets/slide-2-1.png)\n');
    await write('sources/2026-11-05-plain.md', 'text');
    await write('sources/2026-11-05-emf.md', 'text');
    await write(
      'brain/pictures-dropped.json',
      JSON.stringify({
        'sources/2026-11-05-emf.md': {
          dropped: [
            { where: 'slide 1', reason: 'r', fix: 'f', accepted: null },
          ],
          tiny: 0,
        },
      }),
    );
    await write('sources/wiki/Home.md', '![a](.attachments/m.png)');
    await write('sources/wiki/.attachments/m.png', 'x');
    expect(await assetsOf(dir, SOURCE)).toEqual([
      `${ASSETS}/slide-10-1.png`,
      `${ASSETS}/slide-2-1.png`,
    ]);
    expect(await assetsOf(dir, MIRROR_SOURCE)).toEqual([
      'sources/wiki/.attachments/m.png',
    ]);
    expect(await assetsOf(dir, 'sources/2026-11-05-plain.md')).toEqual([]);

    const all = await brainCoverage(dir, await readPages(dir), [
      row(SOURCE),
      row('sources/2026-11-05-plain.md'),
      row('sources/2026-11-05-emf.md'),
      row('sources/wiki/Home.md'),
    ]);
    expect(all.map((s) => [s.source, s.counts.total])).toEqual([
      [SOURCE, 2],
      ['sources/2026-11-05-emf.md', 1],
      [MIRROR_SOURCE, 1],
    ]);
    expect(all[0].rows.find((r) => r.label === 'Slide 2')?.alt).toBe('Logo');
    expect(all[2].rows[0]).toMatchObject({
      label: 'Wiki attachment',
      status: 'missing',
    });
  });
});
