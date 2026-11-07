import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrainSchema,
  type Brain,
  type BrainJob,
  type BrainSourceRow,
} from '../../shared/brain';
import { GitClient } from '../services/GitClient';
import { BrainJobRunner } from './jobs';
import { readPages } from './pages';
import {
  afterPictureJob,
  createPictureHooks,
  assetsOf,
  brainCoverage,
  coverage,
  DROPPED_FILE,
  mergePass,
  MIRROR_SOURCE,
  notePassJob,
  pictureFindings,
  pictureLabel,
  picturesPrompt,
  readDropped,
  readSkipped,
  rebuildDrops,
  runPicturePass,
  sourceCoverage,
  writeDropped,
  type DroppedFile,
  type SkippedFile,
} from './pictures';
import { scaffoldBrain } from './scaffold';
import { addSource, listSources } from './sources';
import { writeState } from './state';

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

  it('reads a skipped key written with ./, URL encoding or backslashes as the plain path', async () => {
    await write(
      'brain/pictures-skipped.json',
      JSON.stringify({
        './sources/x-assets/a%20b.png': { reason: 'logo', at: 'x' },
        'sources\\x-assets\\c.png': { reason: 'logo', at: 'y' },
        'sources/x-assets/bad%zz.png': { reason: 'logo', at: 'z' },
      }),
    );
    expect(Object.keys(await readSkipped(dir))).toEqual([
      'sources/x-assets/a b.png',
      'sources/x-assets/c.png',
      'sources/x-assets/bad%zz.png',
    ]);
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
        detail: '1 picture not interpreted · 2 never reached the agent',
        code: 'pictures-dropped',
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

  it('covers one source on its own, as brainCoverage does', async () => {
    await write(`${ASSETS}/slide-2-1.png`, 'x');
    await write(SOURCE, '![Logo](2026-11-04-deck-assets/slide-2-1.png)\n');
    const one = await sourceCoverage(dir, await readPages(dir), SOURCE);
    expect(one.rows[0]).toMatchObject({ status: 'missing', alt: 'Logo' });
    expect(
      await brainCoverage(dir, await readPages(dir), [row(SOURCE)]),
    ).toEqual([one]);
  });

  it('leaves out alt texts, without reading the source, when asked', async () => {
    await write(SOURCE, '![Org chart](2026-11-04-deck-assets/slide-1-1.png)\n');
    await write(`${ASSETS}/slide-1-1.png`, 'x');
    const pages = await readPages(dir);
    const one = await sourceCoverage(dir, pages, SOURCE, { alt: false });
    expect(one.rows[0]).toMatchObject({ status: 'missing', alt: null });
    expect((await sourceCoverage(dir, pages, SOURCE)).rows[0].alt).toBe(
      'Org chart',
    );
    const [all] = await brainCoverage(dir, pages, [row(SOURCE)], {
      alt: false,
    });
    expect(all.rows[0].alt).toBeNull();
  });

  it('refuses to write over a dropped file that is not valid JSON, and reads it as empty', async () => {
    await write(DROPPED_FILE, '{ "sources/a.md": ');
    expect(await readDropped(dir)).toEqual({});
    await expect(writeDropped(dir, (f) => f)).rejects.toThrow(
      'brain/pictures-dropped.json is not valid JSON; fix or remove it',
    );
    expect(await fs.readFile(path.join(dir, DROPPED_FILE), 'utf8')).toBe(
      '{ "sources/a.md": ',
    );
  });

  describe('re-evaluation', () => {
    const job = (over: Partial<BrainJob> = {}): BrainJob => ({
      id: 'j',
      brainId: 'b',
      kind: 'capture',
      source: 'sources/x.md',
      status: 'done',
      startedAt: null,
      endedAt: null,
      sessionId: null,
      result: null,
      error: null,
      background: false,
      agent: 'claude',
      ...over,
    });
    const gap = async () => {
      await write('sources/x.md', 'text');
      await write('sources/x-assets/slide-11-1.png', 'x');
    };
    const after = async (
      j: BrainJob,
      o: { templatesVersion?: number; jobs?: BrainJob[] } = {},
    ) => {
      const enqueue = vi.fn();
      await afterPictureJob(j, {
        brain: () => ({ path: dir, templatesVersion: o.templatesVersion ?? 6 }),
        enqueue,
        jobs: () => o.jobs ?? [],
      });
      return enqueue;
    };

    it('prompts with the pictures not interpreted, and nothing when there are none', async () => {
      await gap();
      expect(await picturesPrompt(dir, 'sources/x.md')).toBe(
        '/pictures sources/x.md ["sources/x-assets/slide-11-1.png"]',
      );
      await write(
        'brain/pictures-dropped.json',
        JSON.stringify({
          'sources/x.md': {
            dropped: [
              { where: 'slide 9', reason: 'r', fix: 'f', accepted: null },
            ],
            tiny: 0,
          },
        }),
      );
      await write('wiki/x.md', '![a](../sources/x-assets/slide-11-1.png)\n');
      expect(await picturesPrompt(dir, 'sources/x.md')).toBeNull();
    });

    it('queues one pictures job after a capture that left gaps', async () => {
      await gap();
      expect((await after(job())).mock.calls).toEqual([
        ['b', 'pictures', 'sources/x.md'],
      ]);
    });

    it('never queues after a pictures job, a failed capture or a capture without gaps', async () => {
      await gap();
      expect(await after(job({ kind: 'pictures' }))).not.toHaveBeenCalled();
      expect(await after(job({ status: 'failed' }))).not.toHaveBeenCalled();
      expect(
        await after(job({ source: 'sources/plain.md' })),
      ).not.toHaveBeenCalled();
    });

    it('never queues on a brain whose skills are older than v6', async () => {
      await gap();
      expect(
        await after(job(), { templatesVersion: 5 }),
      ).not.toHaveBeenCalled();
    });

    it('never queues when a pictures job for the source is already coming', async () => {
      await gap();
      for (const status of ['queued', 'running', 'paused'] as const)
        expect(
          await after(job(), {
            jobs: [job({ kind: 'pictures', status, background: true })],
          }),
        ).not.toHaveBeenCalled();
      // A finished one, or one for another source, does not count.
      expect(
        (
          await after(job(), {
            jobs: [
              job({ kind: 'pictures', status: 'done' }),
              job({ kind: 'pictures', source: 'sources/y.md' }),
            ],
          })
        ).mock.calls,
      ).toHaveLength(1);
    });

    it('logs instead of throwing when the brain is gone', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const enqueue = vi.fn();
      await afterPictureJob(job(), {
        brain: () => {
          throw new Error('Unknown brain b');
        },
        enqueue,
        jobs: () => [],
      });
      expect(enqueue).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
      log.mockRestore();
    });
  });
});

const REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** One slide with a PNG and an EMF (which macOS cannot convert: one drop). */
async function deckWithEmf(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'ppt/presentation.xml',
    '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships><Relationship Id="rId1" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`,
  );
  zip.file(
    'ppt/slides/slide1.xml',
    '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Architecture</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="4" name="P"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic><p:pic><p:nvPicPr><p:cNvPr id="5" name="Q"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>',
  );
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    `<Relationships><Relationship Id="rId2" Type="${REL}/image" Target="../media/image1.png"/><Relationship Id="rId3" Type="${REL}/image" Target="../media/image2.emf"/></Relationships>`,
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  zip.file('ppt/media/image1.png', png);
  zip.file('ppt/media/image2.emf', png);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('one-time pass over earlier sources', () => {
  const git = new GitClient();
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-pass-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (rel: string, text: string) => {
    const file = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  const commitAll = async (message: string) => {
    await git.run(dir, ['add', '-A']);
    await git.run(dir, ['commit', '-q', '-m', message]);
  };
  const subjects = async () =>
    (await git.run(dir, ['log', '--format=%s'])).trim().split('\n');
  const at = (day: string) => () => new Date(`2026-11-${day}T09:00:00Z`);

  /** A deck added before drops were recorded: its record is taken out again. */
  const earlierDeck = async () => {
    const f = path.join(root, 'Deck.pptx');
    await fs.writeFile(f, await deckWithEmf());
    const r = await addSource(git, dir, { file: f }, 'deck', at('01'));
    if (!r.ok) throw new Error(r.message);
    await fs.rm(path.join(dir, DROPPED_FILE));
    await commitAll('earlier');
    return r.path;
  };

  describe('rebuildDrops', () => {
    it("rebuilds a stored deck's drop record and never touches the source", async () => {
      const deck = await earlierDeck();
      await addSource(
        git,
        dir,
        { text: 'pasted', title: 'Note' },
        'note',
        at('02'),
      );
      const before = await fs.readFile(path.join(dir, deck));
      const original = deck.replace(/\.md$/, '.pptx');
      const originalBefore = await fs.readFile(path.join(dir, original));

      await rebuildDrops(git, dir, await listSources(dir, null), {});

      const dropped = await readDropped(dir);
      expect(Object.keys(dropped)).toEqual([deck]);
      expect(dropped[deck].dropped).toEqual([
        expect.objectContaining({ accepted: null }),
      ]);
      expect(dropped[deck].dropped[0].reason).toMatch(/EMF/);
      expect((await fs.readFile(path.join(dir, deck))).equals(before)).toBe(
        true,
      );
      expect(
        (await fs.readFile(path.join(dir, original))).equals(originalBefore),
      ).toBe(true);
      expect((await subjects())[0]).toBe(
        'Brain: dropped pictures of earlier sources',
      );
      expect(
        (await git.run(dir, ['show', '--name-only', '--format=', 'HEAD']))
          .trim()
          .split('\n'),
      ).toEqual([DROPPED_FILE]);
      expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
    });

    it('leaves a source that has a record alone and commits nothing when nothing changed', async () => {
      const deck = await earlierDeck();
      await writeDropped(dir, () => ({
        [deck]: {
          dropped: [
            { where: 'slide 1', reason: 'r', fix: 'f', accepted: 'when' },
          ],
          tiny: 0,
        },
      }));
      await commitAll('accepted');
      const sources = await listSources(dir, null);
      await rebuildDrops(git, dir, sources, {});
      expect((await readDropped(dir))[deck].dropped[0].accepted).toBe('when');
      expect((await subjects())[0]).toBe('accepted');
    });

    it('records a source with nothing dropped as checked: not converted again, no row, no finding', async () => {
      const f = path.join(root, 'Kickoff.vtt');
      await fs.writeFile(
        f,
        'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Ann>Welcome.\n',
      );
      const r = await addSource(git, dir, { file: f }, 'transcript', at('01'));
      if (!r.ok) throw new Error(r.message);
      await rebuildDrops(git, dir, await listSources(dir, null), {});
      expect(await readDropped(dir)).toEqual({
        [r.path]: { dropped: [], tiny: 0 },
      });
      expect((await subjects())[0]).toBe(
        'Brain: dropped pictures of earlier sources',
      );
      // An unreadable original would log if it were converted again.
      await fs.chmod(path.join(dir, r.path.replace(/\.md$/, '.vtt')), 0o000);
      const log = vi.spyOn(console, 'error');
      await rebuildDrops(git, dir, await listSources(dir, null), {});
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
      const all = await brainCoverage(
        dir,
        await readPages(dir),
        await listSources(dir, null),
      );
      expect(all).toEqual([]);
      expect(pictureFindings(all, 't')).toEqual([]);
    });

    it('records an original that does not convert as checked, with one log line', async () => {
      const deck = await earlierDeck();
      await fs.writeFile(
        path.join(dir, deck.replace(/\.md$/, '.pptx')),
        'not a zip',
      );
      await commitAll('broken');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      await rebuildDrops(git, dir, await listSources(dir, null), {});
      expect(log).toHaveBeenCalledTimes(1);
      expect(await readDropped(dir)).toEqual({
        [deck]: { dropped: [], tiny: 0 },
      });
      expect((await subjects())[0]).toBe(
        'Brain: dropped pictures of earlier sources',
      );
      // Not converted again on the next run.
      await rebuildDrops(git, dir, await listSources(dir, null), {});
      expect(log).toHaveBeenCalledTimes(1);
      log.mockRestore();
    });
  });

  describe('runPicturePass', () => {
    const brain = (over: Partial<Brain> = {}): Brain =>
      BrainSchema.parse({
        id: 'b',
        name: 'B',
        connectionId: 'c',
        project: 'p',
        path: dir,
        createdAt: 't',
        templatesVersion: 6,
        ...over,
      });
    const source = async (day: string, pictures: boolean, captured = true) => {
      const stem = `sources/2026-11-${day}-s${day}`;
      await write(
        `${stem}.md`,
        `---\ntitle: S\nsource_url: s\ningested_at: "2026-11-${day}T09:00:00.000Z"\ncontent_type: deck\nsha256: h${day}\n---\n\nText\n`,
      );
      if (pictures) await write(`${stem}-assets/slide-1-1.png`, 'x');
      if (captured)
        await writeState(dir, (s) => ({
          ...s,
          captured: {
            ...s.captured,
            [`${stem}.md`]: { at: 't', sessionId: null },
          },
        }));
      return `${stem}.md`;
    };
    const job = (over: Partial<BrainJob>): BrainJob => ({
      id: 'j',
      brainId: 'b',
      kind: 'pictures',
      source: null,
      status: 'queued',
      startedAt: null,
      endedAt: null,
      sessionId: null,
      result: null,
      error: null,
      background: true,
      agent: 'claude',
      ...over,
    });
    const now = () => new Date('2026-11-07T12:00:00.000Z');
    const pass = async (b: Brain, jobs: BrainJob[] = []) => {
      const enqueue = vi.fn();
      const next = await runPicturePass(b, {
        git,
        enqueue,
        jobs: () => jobs,
        now,
      });
      return { next, queued: enqueue.mock.calls };
    };

    it('queues a background job per source with gaps, oldest first, the mirror last', async () => {
      const newer = await source('03', true);
      const older = await source('01', true);
      await source('02', false);
      await write(`${MIRROR_SOURCE}/.attachments/a.png`, 'x');
      const { next, queued } = await pass(brain());
      expect(queued).toEqual([
        ['b', 'pictures', older, { background: true }],
        ['b', 'pictures', newer, { background: true }],
        ['b', 'pictures', MIRROR_SOURCE, { background: true }],
      ]);
      expect(next).toEqual({
        startedAt: '2026-11-07T12:00:00.000Z',
        total: 3,
        sources: [older, newer, MIRROR_SOURCE],
        done: [],
        failures: {},
        finishedAt: null,
      });
    });

    it('resumes after a restart with only the remaining sources, keeping start and total', async () => {
      const older = await source('01', true);
      const newer = await source('03', true);
      const started = {
        startedAt: '2026-11-06T08:00:00.000Z',
        total: 2,
        sources: [older, newer],
        done: [older],
        failures: { [newer]: 1 },
        finishedAt: null,
      };
      const { next, queued } = await pass(brain({ picturePass: started }));
      expect(queued).toEqual([['b', 'pictures', newer, { background: true }]]);
      expect(next).toEqual(started);
    });

    it('never queues a source that is not captured: its capture looks at its pictures', async () => {
      const captured = await source('01', true);
      await source('02', true, false);
      const { next, queued } = await pass(brain());
      expect(queued).toEqual([
        ['b', 'pictures', captured, { background: true }],
      ]);
      expect(next).toMatchObject({ total: 1, sources: [captured] });
    });

    it('covers only what had gaps at its first run: a source or mirror pictures added later are never queued by it', async () => {
      const older = await source('01', true);
      const first = await pass(brain());
      expect(first.queued).toEqual([
        ['b', 'pictures', older, { background: true }],
      ]);
      await source('03', true);
      await write(`${MIRROR_SOURCE}/.attachments/a.png`, 'x');
      const again = await pass(brain({ picturePass: first.next }));
      expect(again.queued).toEqual([
        ['b', 'pictures', older, { background: true }],
      ]);
      expect(again.next).toEqual(first.next);
      // The earlier source done: the pass is over, the later ones untouched.
      const done = await pass(
        brain({ picturePass: { ...first.next!, done: [older] } }),
      );
      expect(done.queued).toEqual([]);
      expect(done.next?.finishedAt).toBe('2026-11-07T12:00:00.000Z');
    });

    it('does not queue a source whose pass job is still queued', async () => {
      const older = await source('01', true);
      const newer = await source('03', true);
      const { next, queued } = await pass(brain(), [
        job({ source: older, status: 'running' }),
      ]);
      expect(queued).toEqual([['b', 'pictures', newer, { background: true }]]);
      expect(next).toMatchObject({ total: 2, finishedAt: null });
    });

    it('does not queue a source that has a capture or a pictures job coming, background or not', async () => {
      const a = await source('01', true);
      const b2 = await source('02', true);
      const c = await source('03', true);
      const { queued } = await pass(brain(), [
        job({ source: a, kind: 'capture', background: false }),
        job({ source: b2, background: false, status: 'paused' }),
        job({ source: c, kind: 'capture', status: 'done' }),
      ]);
      expect(queued).toEqual([['b', 'pictures', c, { background: true }]]);
    });

    it('finishes at once when nothing has gaps', async () => {
      await source('01', false);
      const { next, queued } = await pass(brain());
      expect(queued).toEqual([]);
      expect(next).toEqual({
        startedAt: '2026-11-07T12:00:00.000Z',
        total: 0,
        sources: [],
        done: [],
        failures: {},
        finishedAt: '2026-11-07T12:00:00.000Z',
      });
    });

    it('rebuilds drop records before it looks at the gaps', async () => {
      const deck = await earlierDeck();
      await writeState(dir, (s) => ({
        ...s,
        captured: { ...s.captured, [deck]: { at: 't', sessionId: null } },
      }));
      const { queued } = await pass(brain());
      expect(Object.keys(await readDropped(dir))).toEqual([deck]);
      expect(queued).toEqual([['b', 'pictures', deck, { background: true }]]);
    });
  });

  describe('mergePass', () => {
    const computed = {
      startedAt: 's',
      total: 3,
      sources: ['sources/a.md', 'sources/b.md', 'sources/c.md'],
      done: ['sources/a.md'],
      failures: {},
      finishedAt: null,
    };
    it('keeps sources noted done meanwhile and a finish already saved', () => {
      expect(
        mergePass(
          { ...computed, done: ['sources/a.md', 'sources/b.md'] },
          computed,
        ),
      ).toEqual({ ...computed, done: ['sources/a.md', 'sources/b.md'] });
      expect(
        mergePass({ ...computed, finishedAt: 'f' }, computed),
      ).toMatchObject({ finishedAt: 'f' });
      expect(
        mergePass(computed, { ...computed, finishedAt: 'g' }),
      ).toMatchObject({ finishedAt: 'g' });
      expect(
        mergePass({ ...computed, failures: { 'sources/b.md': 1 } }, computed),
      ).toMatchObject({ failures: { 'sources/b.md': 1 } });
      expect(mergePass(null, computed)).toBe(computed);
    });
  });

  describe('notePassJob', () => {
    const b = (picturePass: Brain['picturePass']): Brain =>
      BrainSchema.parse({
        id: 'b',
        name: 'B',
        connectionId: 'c',
        project: 'p',
        path: '/x',
        createdAt: 't',
        picturePass,
      });
    const pass = {
      startedAt: 's',
      total: 2,
      sources: ['sources/a.md', 'sources/b.md'],
      done: ['sources/a.md'],
      failures: {},
      finishedAt: null,
    };
    const finished = (over: Partial<BrainJob> = {}): BrainJob => ({
      id: 'j',
      brainId: 'b',
      kind: 'pictures',
      source: 'sources/b.md',
      status: 'done',
      startedAt: null,
      endedAt: null,
      sessionId: null,
      result: null,
      error: null,
      background: true,
      agent: 'claude',
      ...over,
    });
    const now = new Date('2026-11-07T12:00:00.000Z');

    it('adds the source of a finished pass job and finishes the pass at the total', () => {
      expect(notePassJob(b(pass), finished(), now)).toEqual({
        ...pass,
        done: ['sources/a.md', 'sources/b.md'],
        finishedAt: '2026-11-07T12:00:00.000Z',
      });
      // A Re-evaluate on a pass source replaced its background job: it counts the same.
      expect(
        notePassJob(b(pass), finished({ background: false }), now),
      ).toMatchObject({ done: ['sources/a.md', 'sources/b.md'] });
    });

    it('counts a failed run, and the source as done only at the second failure', () => {
      const once = notePassJob(b(pass), finished({ status: 'failed' }), now);
      expect(once).toEqual({ ...pass, failures: { 'sources/b.md': 1 } });
      expect(notePassJob(b(once), finished({ status: 'failed' }), now)).toEqual(
        {
          ...pass,
          done: ['sources/a.md', 'sources/b.md'],
          failures: { 'sources/b.md': 2 },
          finishedAt: '2026-11-07T12:00:00.000Z',
        },
      );
      expect(notePassJob(b(once), finished(), now)).toMatchObject({
        done: ['sources/a.md', 'sources/b.md'],
      });
    });

    it('ignores other jobs, a source already done or not in the pass and a brain without a pass', () => {
      const p = b(pass);
      expect(
        notePassJob(p, finished({ source: 'sources/later.md' }), now),
      ).toBe(p.picturePass);
      expect(notePassJob(p, finished({ kind: 'capture' }), now)).toBe(
        p.picturePass,
      );
      expect(notePassJob(p, finished({ status: 'running' }), now)).toBe(
        p.picturePass,
      );
      expect(notePassJob(p, finished({ source: 'sources/a.md' }), now)).toBe(
        p.picturePass,
      );
      expect(notePassJob(b(null), finished(), now)).toBeNull();
    });
  });
});

describe('createPictureHooks', () => {
  const git = new GitClient();
  let root: string;
  let dir: string;
  let stored: Brain;
  let runs: string[];
  let runner: BrainJobRunner;
  /** What a fake pictures run does: describe every picture it is handed, nothing, or fail. */
  let pictureRun: 'describe' | 'nothing' | 'fail';
  /** While set, a lint run waits for it. */
  let holdLint: Promise<void> | null;
  beforeEach(async () => {
    pictureRun = 'describe';
    holdLint = null;
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-hooks-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
    stored = BrainSchema.parse({
      id: 'b',
      name: 'B',
      connectionId: 'c',
      project: 'p',
      path: dir,
      createdAt: 't',
      templatesVersion: 6,
    });
    runs = [];
  });
  afterEach(async () => {
    runner?.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (rel: string, text: string) => {
    const file = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  /** A source with one picture not interpreted; captured unless told otherwise. */
  const source = async (name: string, captured = true) => {
    const rel = `sources/2026-11-01-${name}.md`;
    await write(
      rel,
      `---\ntitle: ${name}\nsource_url: s\ningested_at: "2026-11-01T09:00:00.000Z"\ncontent_type: deck\nsha256: ${name}\n---\n\nText\n`,
    );
    await write(`sources/2026-11-01-${name}-assets/slide-1-1.png`, 'x');
    if (captured)
      await writeState(dir, (s) => ({
        ...s,
        captured: { ...s.captured, [rel]: { at: 't', sessionId: null } },
      }));
    return rel;
  };
  /** The hooks on a real runner whose Claude is fake (see `pictureRun`). */
  const setup = () => {
    const brains = {
      get: (id: string) => (id === 'b' ? stored : undefined),
      patch: async (_id: string, p: Partial<Brain>) => {
        stored = { ...stored, ...p };
      },
    };
    const hooks = createPictureHooks({
      brains,
      runner: () => runner,
      git,
      now: () => new Date('2026-11-07T12:00:00.000Z'),
    });
    runner = new BrainJobRunner({
      platform: {
        claudeCommand: (_c, flags) => ({
          command: 'claude',
          args: flags ?? [],
          env: {},
        }),
        opencodeCommand: () => ({ command: 'opencode', args: [] }),
      },
      run: (async (_cmd: unknown, o: { input: string }) => {
        runs.push(o.input);
        if (o.input === '/lint' && holdLint) await holdLint;
        const m = /^\/pictures (\S+) (\[.*\])$/.exec(o.input);
        if (m && pictureRun === 'fail') throw new Error('Claude failed');
        if (m && pictureRun === 'describe') {
          const files = JSON.parse(m[2]) as string[];
          await write(
            `wiki/${path.basename(m[1])}`,
            files.map((f) => `![p](../${f})`).join('\n'),
          );
        }
        return JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 's',
        });
      }) as never,
      env: () => ({}),
      tokensToday: () => 0,
      cap: () => 1_000_000,
      brainDir: () => dir,
      model: () => 'sonnet',
      agent: () => 'claude',
      opencodeModel: () => null,
      ready: () => true,
      onChange: () => undefined,
      commit: async () => undefined,
      beforeJob: async () => undefined,
      promptFor: hooks.promptFor,
      afterJob: hooks.afterJob,
    });
    return hooks;
  };
  const idle = () =>
    vi.waitFor(() => {
      expect(runner.running('b')).toBe(false);
      expect(
        runner
          .jobs('b')
          .every((j) => j.status === 'done' || j.status === 'failed'),
      ).toBe(true);
    });

  it('runs the pass end to end: a capture queues its pictures job, the pass job is noted and the pass finishes', async () => {
    const earlier = await source('earlier');
    const added = await source('added', false);
    const hooks = setup();
    await hooks.picturePass('b');
    expect(stored.picturePass).toMatchObject({ total: 1, sources: [earlier] });
    expect(hooks.passRunning('b')).toBe(true);
    runner.enqueue('b', 'capture', added);
    await idle();
    // The pass job started on the idle lane; then the capture, its lint and the pictures job the capture queued.
    expect(runs).toEqual([
      `/pictures ${earlier} ["sources/2026-11-01-earlier-assets/slide-1-1.png"]`,
      `/capture ${added}`,
      '/lint',
      `/pictures ${added} ["sources/2026-11-01-added-assets/slide-1-1.png"]`,
    ]);
    await vi.waitFor(() =>
      expect(stored.picturePass).toMatchObject({
        done: [earlier],
        finishedAt: '2026-11-07T12:00:00.000Z',
      }),
    );
    expect(hooks.passRunning('b')).toBe(false);
    // Run again (the scheduler would not): nothing left, nothing queued.
    await hooks.picturePass('b');
    await idle();
    expect(runs).toHaveLength(4);
  });

  it('a capture of a source with a background pictures job queued adds no second pictures run', async () => {
    const earlier = await source('earlier');
    pictureRun = 'nothing';
    const hooks = setup();
    // Hold the lane so the background job stays queued while the capture is added.
    let release = () => {};
    holdLint = new Promise((r) => (release = r));
    runner.enqueue('b', 'lint');
    await hooks.picturePass('b');
    runner.enqueue('b', 'capture', earlier);
    holdLint = null;
    release();
    await idle();
    expect(runs[0]).toBe('/lint');
    expect(runs.filter((r) => r.startsWith('/pictures'))).toHaveLength(1);
    expect(runs.filter((r) => r.startsWith('/capture'))).toHaveLength(1);
  });

  it('a failed pass job runs once more on the next pass, then gives up', async () => {
    const earlier = await source('earlier');
    pictureRun = 'fail';
    const hooks = setup();
    await hooks.picturePass('b');
    await idle();
    await vi.waitFor(() =>
      expect(stored.picturePass?.failures).toEqual({ [earlier]: 1 }),
    );
    expect(stored.picturePass?.finishedAt).toBeNull();
    await hooks.picturePass('b');
    await idle();
    await vi.waitFor(() =>
      expect(stored.picturePass).toMatchObject({
        done: [earlier],
        failures: { [earlier]: 2 },
        finishedAt: '2026-11-07T12:00:00.000Z',
      }),
    );
    expect(runs).toHaveLength(2);
  });

  it('ends a pictures job without Claude on a brain older than v6', async () => {
    const earlier = await source('earlier');
    stored = { ...stored, templatesVersion: 5 };
    setup();
    const job = runner.enqueue('b', 'pictures', earlier);
    await idle();
    expect(runs).toEqual([]);
    expect(runner.jobs('b').find((j) => j.id === job.id)).toMatchObject({
      status: 'done',
      result: 'Nothing to re-evaluate',
    });
  });
});
