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
import { readPages } from './pages';
import {
  afterPictureJob,
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

  it('covers one source on its own, as brainCoverage does', async () => {
    await write(`${ASSETS}/slide-2-1.png`, 'x');
    await write(SOURCE, '![Logo](2026-11-04-deck-assets/slide-2-1.png)\n');
    const one = await sourceCoverage(dir, await readPages(dir), SOURCE);
    expect(one.rows[0]).toMatchObject({ status: 'missing', alt: 'Logo' });
    expect(
      await brainCoverage(dir, await readPages(dir), [row(SOURCE)]),
    ).toEqual([one]);
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
      ...over,
    });
    const gap = async () => {
      await write('sources/x.md', 'text');
      await write('sources/x-assets/slide-11-1.png', 'x');
    };
    const after = async (j: BrainJob) => {
      const enqueue = vi.fn();
      await afterPictureJob(j, { brainDir: () => dir, enqueue });
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

    it('logs instead of throwing when the brain is gone', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const enqueue = vi.fn();
      await afterPictureJob(job(), {
        brainDir: () => {
          throw new Error('Unknown brain b');
        },
        enqueue,
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

    it('skips an original that does not convert, with a log line', async () => {
      const deck = await earlierDeck();
      await fs.writeFile(
        path.join(dir, deck.replace(/\.md$/, '.pptx')),
        'not a zip',
      );
      await commitAll('broken');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      await rebuildDrops(git, dir, await listSources(dir, null), {});
      expect(log).toHaveBeenCalled();
      log.mockRestore();
      expect(await readDropped(dir)).toEqual({});
      expect((await subjects())[0]).toBe('broken');
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
    const source = async (day: string, pictures: boolean) => {
      const stem = `sources/2026-11-${day}-s${day}`;
      await write(
        `${stem}.md`,
        `---\ntitle: S\nsource_url: s\ningested_at: "2026-11-${day}T09:00:00.000Z"\ncontent_type: deck\nsha256: h${day}\n---\n\nText\n`,
      );
      if (pictures) await write(`${stem}-assets/slide-1-1.png`, 'x');
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
        done: [],
        finishedAt: null,
      });
    });

    it('resumes after a restart with only the remaining sources, keeping start and total', async () => {
      const older = await source('01', true);
      const newer = await source('03', true);
      const started = {
        startedAt: '2026-11-06T08:00:00.000Z',
        total: 2,
        done: [older],
        finishedAt: null,
      };
      const { next, queued } = await pass(brain({ picturePass: started }));
      expect(queued).toEqual([['b', 'pictures', newer, { background: true }]]);
      expect(next).toEqual(started);
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
        done: [],
        finishedAt: '2026-11-07T12:00:00.000Z',
      });
    });

    it('rebuilds drop records before it looks at the gaps', async () => {
      const deck = await earlierDeck();
      const { queued } = await pass(brain());
      expect(Object.keys(await readDropped(dir))).toEqual([deck]);
      expect(queued).toEqual([['b', 'pictures', deck, { background: true }]]);
    });
  });

  describe('mergePass', () => {
    const computed = {
      startedAt: 's',
      total: 3,
      done: ['sources/a.md'],
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
      done: ['sources/a.md'],
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
      ...over,
    });
    const now = new Date('2026-11-07T12:00:00.000Z');

    it('adds the source of a finished pass job and finishes the pass at the total', () => {
      expect(notePassJob(b(pass), finished(), now)).toEqual({
        ...pass,
        done: ['sources/a.md', 'sources/b.md'],
        finishedAt: '2026-11-07T12:00:00.000Z',
      });
      expect(
        notePassJob(
          b({ ...pass, total: 3 }),
          finished({ status: 'failed' }),
          now,
        ),
      ).toEqual({
        ...pass,
        total: 3,
        done: ['sources/a.md', 'sources/b.md'],
      });
    });

    it('ignores other jobs, a source already done and a brain without a pass', () => {
      const p = b(pass);
      expect(notePassJob(p, finished({ background: false }), now)).toBe(
        p.picturePass,
      );
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
