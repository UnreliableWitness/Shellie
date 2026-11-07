import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitClient } from '../services/GitClient';
import { scaffoldBrain } from './scaffold';
import { addSource, listSources, removeSource } from './sources';
import { readState, writeState } from './state';

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
<v Ann>Welcome to the kickoff.
`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** One slide with a title, a picture and a picture in a format Claude cannot view. */
async function deckWithPicture(): Promise<Buffer> {
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
    '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Architecture</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="4" name="P" descr="Three tiers"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic><p:pic><p:nvPicPr><p:cNvPr id="5" name="Q"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>',
  );
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    `<Relationships><Relationship Id="rId2" Type="${REL}/image" Target="../media/image1.png"/><Relationship Id="rId3" Type="${REL}/image" Target="../media/image2.emf"/></Relationships>`,
  );
  zip.file('ppt/media/image1.png', PNG);
  zip.file('ppt/media/image2.emf', PNG);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('brain sources', () => {
  let root: string;
  let dir: string;
  const git = new GitClient();
  const now = () => new Date('2026-11-03T09:00:00Z');

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-src-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const clean = async () =>
    (await git.run(dir, ['status', '--porcelain'])).trim();

  it('adds a text note as a source and commits', async () => {
    const r = await addSource(
      git,
      dir,
      { text: 'hello', title: 'Note' },
      'note',
      now,
    );
    expect(r).toEqual({
      ok: true,
      path: 'sources/2026-11-03-note.md',
      images: 0,
      dropped: 0,
      warnings: [],
      contents: expect.any(String),
    });
    const text = await fs.readFile(
      path.join(dir, 'sources/2026-11-03-note.md'),
      'utf8',
    );
    expect(text).toMatch(/content_type: note/);
    expect(text).toMatch(/source_url: Note/);
    expect(await clean()).toBe('');
    expect((await git.run(dir, ['log', '-1', '--format=%s'])).trim()).toBe(
      'Brain: add source 2026-11-03-note.md',
    );
  });

  it('writes the note into the frontmatter, trimmed, and lists it', async () => {
    const r = await addSource(
      git,
      dir,
      {
        text: 'hello',
        title: 'Note',
        note: '  From the kickoff call; rough  ',
      },
      'note',
      now,
    );
    if (!r.ok) throw new Error(r.message);
    const text = await fs.readFile(path.join(dir, r.path), 'utf8');
    expect(text).toMatch(/^note: From the kickoff call; rough$/m);
    expect(text).toContain('---\n\nhello\n');
    const blank = await addSource(
      git,
      dir,
      { text: 'other', title: 'Other', note: '   ' },
      'note',
      now,
    );
    if (!blank.ok) throw new Error(blank.message);
    expect(await fs.readFile(path.join(dir, blank.path), 'utf8')).not.toMatch(
      /^note:/m,
    );
    const rows = await listSources(dir, null);
    expect(rows.map((s) => [s.path, s.note])).toEqual([
      ['sources/2026-11-03-note.md', 'From the kickoff call; rough'],
      ['sources/2026-11-03-other.md', null],
    ]);
  });

  it('copies the original beside a converted file', async () => {
    const f = path.join(root, 'Kickoff.vtt');
    await fs.writeFile(f, VTT);
    const r = await addSource(git, dir, { file: f }, 'transcript', now);
    expect(r).toEqual({
      ok: true,
      path: 'sources/2026-11-03-kickoff.md',
      images: 0,
      dropped: 0,
      warnings: [],
      contents: expect.any(String),
    });
    expect(
      await fs.readFile(
        path.join(dir, 'sources/2026-11-03-kickoff.vtt'),
        'utf8',
      ),
    ).toBe(VTT);
    const md = await fs.readFile(
      path.join(dir, 'sources/2026-11-03-kickoff.md'),
      'utf8',
    );
    expect(md).toContain('source_url: Kickoff.vtt');
    expect(md).toContain('Welcome to the kickoff');
    expect(await clean()).toBe('');
    const rows = await listSources(dir, null);
    expect(rows[0].original).toBe('sources/2026-11-03-kickoff.vtt');
  });

  it('adds an xml file as a code block and keeps the original', async () => {
    const f = path.join(root, 'config.xml');
    const xml = '<?xml version="1.0"?>\n<config><port>8080</port></config>\n';
    await fs.writeFile(f, xml);
    const r = await addSource(git, dir, { file: f }, 'doc', now);
    expect(r).toMatchObject({
      ok: true,
      path: 'sources/2026-11-03-config.md',
      contents: 'XML · <config>',
    });
    expect(
      await fs.readFile(
        path.join(dir, 'sources/2026-11-03-config.xml'),
        'utf8',
      ),
    ).toBe(xml);
    const md = await fs.readFile(
      path.join(dir, 'sources/2026-11-03-config.md'),
      'utf8',
    );
    expect(md).toContain('```xml\n<?xml version="1.0"?>');
    expect(await clean()).toBe('');
  });

  it('five concurrent adds all succeed with one commit each', async () => {
    const before = Number(
      (await git.run(dir, ['rev-list', '--count', 'HEAD'])).trim(),
    );
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        addSource(git, dir, { text: `note ${n}`, title: 'Note' }, 'note', now),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.path : ''))).size).toBe(5);
    const after = Number(
      (await git.run(dir, ['rev-list', '--count', 'HEAD'])).trim(),
    );
    expect(after - before).toBe(5);
    expect(await clean()).toBe('');
  });

  it('commits only the files it wrote', async () => {
    await fs.writeFile(path.join(dir, 'sources', 'stray.md'), 'by hand\n');
    const r = await addSource(
      git,
      dir,
      { text: 'hello', title: 'Note' },
      'note',
      now,
    );
    expect(r.ok).toBe(true);
    expect(await clean()).toBe('?? sources/stray.md');
  });

  it('does not copy a markdown drop twice', async () => {
    const f = path.join(root, 'notes.md');
    await fs.writeFile(f, '# Meeting\n\nbody\n');
    const r = await addSource(git, dir, { file: f }, 'doc', now);
    expect(r.ok).toBe(true);
    const files = await fs.readdir(path.join(dir, 'sources'));
    expect(files.filter((n) => n.startsWith('2026-11-03'))).toEqual([
      '2026-11-03-notes.md',
    ]);
    expect((await listSources(dir, null))[0].original).toBeNull();
  });

  it('rejects a duplicate by sha256', async () => {
    await addSource(git, dir, { text: 'hello', title: 'Note' }, 'note', now);
    const r = await addSource(
      git,
      dir,
      { text: 'hello', title: 'Other' },
      'note',
      now,
    );
    expect(r).toEqual({
      ok: false,
      reason: 'duplicate',
      message: 'Already in the brain as sources/2026-11-03-note.md',
    });
    expect(await clean()).toBe('');
  });

  it('rejects an unsupported extension', async () => {
    const f = path.join(root, 'a.xyz');
    await fs.writeFile(f, 'x');
    const r = await addSource(git, dir, { file: f }, 'doc', now);
    expect(r).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await fs.readdir(path.join(dir, 'sources'))).toEqual(['.gitkeep']);
  });

  it('reports a corrupt file as a readable error and writes nothing', async () => {
    const f = path.join(root, 'broken.pptx');
    await fs.writeFile(f, 'not a zip');
    const r = await addSource(git, dir, { file: f }, 'deck', now);
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    expect(r.ok === false && r.message).toMatch(/pptx/i);
    expect(await fs.readdir(path.join(dir, 'sources'))).toEqual(['.gitkeep']);
    expect(await clean()).toBe('');
  });

  it('reports a scan without text as needs-ocr', async () => {
    const f = path.resolve(__dirname, 'convert/__fixtures__/image-only.pdf');
    const r = await addSource(git, dir, { file: f }, 'doc', now);
    expect(r).toEqual({
      ok: false,
      reason: 'needs-ocr',
      message: 'No text layer and no images; needs OCR',
    });
    expect(await fs.readdir(path.join(dir, 'sources'))).toEqual(['.gitkeep']);
  });

  it("stores a deck's pictures beside the source, linked from the slide", async () => {
    const f = path.join(root, 'Platform Deck.pptx');
    await fs.writeFile(f, await deckWithPicture());
    const r = await addSource(git, dir, { file: f }, 'deck', now);
    expect(r).toEqual({
      ok: true,
      path: 'sources/2026-11-03-platform-deck.md',
      images: 1,
      dropped: 1,
      warnings: ['1 picture in formats the agent cannot view (emf)'],
      contents: '1 slide · 1 picture: Architecture',
    });
    const text = await fs.readFile(
      path.join(dir, 'sources/2026-11-03-platform-deck.md'),
      'utf8',
    );
    expect(text).toContain(
      '## Slide 1\nArchitecture\n![Three tiers](2026-11-03-platform-deck-assets/slide-1-1.png)\n_Picture 2 (emf) could not be extracted_',
    );
    expect(text).toContain('contents: "1 slide · 1 picture: Architecture"');
    expect(r.ok && r.contents).toBe('1 slide · 1 picture: Architecture');
    expect(text).not.toContain('{{assets}}');
    expect(text).toContain(
      '> Note: 1 picture in formats the agent cannot view (emf)',
    );
    const asset = await fs.readFile(
      path.join(dir, 'sources/2026-11-03-platform-deck-assets/slide-1-1.png'),
    );
    expect(asset.equals(PNG)).toBe(true);
    expect(await clean()).toBe('');
    const committed = (
      await git.run(dir, ['show', '--stat', '--format=', 'HEAD'])
    ).trim();
    expect(committed).toContain(
      '2026-11-03-platform-deck-assets/slide-1-1.png',
    );
    expect(committed).toContain('2026-11-03-platform-deck.pptx');
    const rows = await listSources(dir, null);
    expect(rows).toEqual([
      expect.objectContaining({
        path: 'sources/2026-11-03-platform-deck.md',
        original: 'sources/2026-11-03-platform-deck.pptx',
        contents: '1 slide · 1 picture: Architecture',
      }),
    ]);
  });

  it('leaves a literal {{assets}} in a source without pictures alone', async () => {
    const r = await addSource(
      git,
      dir,
      { text: 'Logo at {{assets}}/logo.png', title: 'Template' },
      'note',
      now,
    );
    expect(r).toMatchObject({ ok: true, images: 0 });
    const text = await fs.readFile(
      path.join(dir, 'sources/2026-11-03-template.md'),
      'utf8',
    );
    expect(text).toContain('Logo at {{assets}}/logo.png');
  });

  it('records dropped pictures in the add commit', async () => {
    const f = path.join(root, 'Deck.pptx');
    await fs.writeFile(f, await deckWithPicture());
    const r = await addSource(git, dir, { file: f }, 'deck', now);
    expect(r).toMatchObject({ ok: true, dropped: 1 });
    const recorded = JSON.parse(
      await fs.readFile(path.join(dir, 'brain/pictures-dropped.json'), 'utf8'),
    );
    expect(recorded['sources/2026-11-03-deck.md']).toEqual({
      dropped: [
        expect.objectContaining({
          reason: 'EMF converts on Windows only',
          accepted: null,
        }),
      ],
      tiny: 0,
    });
    expect(
      await git.run(dir, ['show', '--stat', '--format=', 'HEAD']),
    ).toContain('brain/pictures-dropped.json');
    expect(await clean()).toBe('');
  });

  it('adds no drop file when nothing was dropped', async () => {
    await addSource(git, dir, { text: 'hello', title: 'Note' }, 'note', now);
    await expect(
      fs.access(path.join(dir, 'brain/pictures-dropped.json')),
    ).rejects.toThrow();
  });

  it('puts the drop file back when the commit fails', async () => {
    const f = path.join(root, 'Deck.pptx');
    await fs.writeFile(f, await deckWithPicture());
    const failing = Object.create(git) as GitClient;
    failing.run = (cwd, args, opts) =>
      args[0] === 'commit'
        ? Promise.reject(new Error('commit refused'))
        : git.run(cwd, args, opts);
    const r = await addSource(failing, dir, { file: f }, 'deck', now);
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    await expect(
      fs.access(path.join(dir, 'brain/pictures-dropped.json')),
    ).rejects.toThrow();
    expect(await clean()).toBe('');
  });

  it('removes the assets folder when the commit fails', async () => {
    const f = path.join(root, 'Deck.pptx');
    await fs.writeFile(f, await deckWithPicture());
    const failing = Object.create(git) as GitClient;
    failing.run = (cwd, args, opts) =>
      args[0] === 'commit'
        ? Promise.reject(new Error('commit refused'))
        : git.run(cwd, args, opts);
    const r = await addSource(failing, dir, { file: f }, 'deck', now);
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    expect(await fs.readdir(path.join(dir, 'sources'))).toEqual(['.gitkeep']);
    expect(await clean()).toBe('');
  });

  it('listSources marks captured ones, newest first', async () => {
    await addSource(
      git,
      dir,
      { text: 'a', title: 'Old' },
      'note',
      () => new Date('2026-11-01T09:00:00Z'),
    );
    const r = await addSource(
      git,
      dir,
      { text: 'b', title: 'New' },
      'note',
      now,
    );
    if (!r.ok) throw new Error('add failed');
    const rows = await listSources(dir, {
      schemaVersion: 1,
      lastSyncCommit: null,
      lastLintAt: null,
      captured: { [r.path]: { at: 'x', sessionId: null } },
      findings: [],
    });
    expect(rows.map((x) => [x.path, x.captured])).toEqual([
      ['sources/2026-11-03-new.md', true],
      ['sources/2026-11-01-old.md', false],
    ]);
  });

  it('cleans up and allows a retry when the commit fails', async () => {
    const f = path.join(root, 'Kickoff.vtt');
    await fs.writeFile(f, VTT);
    const failing = Object.create(git) as GitClient;
    failing.run = (cwd, args, opts) =>
      args[0] === 'commit'
        ? Promise.reject(new Error('commit refused'))
        : git.run(cwd, args, opts);
    const r = await addSource(failing, dir, { file: f }, 'transcript', now);
    expect(r).toEqual({
      ok: false,
      reason: 'error',
      message: 'commit refused',
    });
    expect(await fs.readdir(path.join(dir, 'sources'))).toEqual(['.gitkeep']);
    expect(await clean()).toBe('');
    expect(await addSource(git, dir, { file: f }, 'transcript', now)).toEqual({
      ok: true,
      path: 'sources/2026-11-03-kickoff.md',
      images: 0,
      dropped: 0,
      warnings: [],
      contents: expect.any(String),
    });
  });

  it('does not report a same-stem neighbour that is not an original', async () => {
    await addSource(git, dir, { text: 'a', title: 'Foo' }, 'note', now);
    await fs.writeFile(path.join(dir, 'sources/2026-11-03-foo.md.bak'), 'x');
    await fs.writeFile(path.join(dir, 'sources/2026-11-03-foo.notes.md'), 'x');
    const rows = await listSources(dir, null);
    expect(rows).toHaveLength(1);
    expect(rows[0].original).toBeNull();
  });

  it('suffixes same-title adds in the same second and lines up originals', async () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    await fs.mkdir(a);
    await fs.mkdir(b);
    await fs.writeFile(path.join(a, 'Kickoff.vtt'), VTT);
    await fs.writeFile(
      path.join(b, 'Kickoff.vtt'),
      VTT.replace('Welcome', 'Hi'),
    );
    const r1 = await addSource(
      git,
      dir,
      { file: path.join(a, 'Kickoff.vtt') },
      'transcript',
      now,
    );
    const r2 = await addSource(
      git,
      dir,
      { file: path.join(b, 'Kickoff.vtt') },
      'transcript',
      now,
    );
    expect(r1).toEqual({
      ok: true,
      path: 'sources/2026-11-03-kickoff.md',
      images: 0,
      dropped: 0,
      warnings: [],
      contents: expect.any(String),
    });
    expect(r2).toEqual({
      ok: true,
      path: 'sources/2026-11-03-kickoff-2.md',
      images: 0,
      dropped: 0,
      warnings: [],
      contents: expect.any(String),
    });
    const rows = await listSources(dir, null);
    expect(rows.map((x) => [x.path, x.original]).sort()).toEqual([
      ['sources/2026-11-03-kickoff-2.md', 'sources/2026-11-03-kickoff-2.vtt'],
      ['sources/2026-11-03-kickoff.md', 'sources/2026-11-03-kickoff.vtt'],
    ]);
    expect(
      await fs.readFile(
        path.join(dir, 'sources/2026-11-03-kickoff-2.vtt'),
        'utf8',
      ),
    ).toContain('Hi');
  });

  it('falls back to "source" when the slug is empty', async () => {
    const f = path.join(root, '日本語.txt');
    await fs.writeFile(f, 'konnichiwa');
    const r1 = await addSource(
      git,
      dir,
      { text: 'x', title: '!!!' },
      'note',
      now,
    );
    const r2 = await addSource(git, dir, { file: f }, 'doc', now);
    expect(r1).toEqual({
      ok: true,
      path: 'sources/2026-11-03-source.md',
      images: 0,
      dropped: 0,
      warnings: [],
      contents: expect.any(String),
    });
    expect(r2).toEqual({
      ok: true,
      path: 'sources/2026-11-03-source-2.md',
      images: 0,
      dropped: 0,
      warnings: [],
      contents: expect.any(String),
    });
  });
});

describe('secret scan at drop time', () => {
  const git = new GitClient();
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-secret-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses pasted text and a file that hold a credential, writing nothing', async () => {
    const r = await addSource(
      git,
      dir,
      {
        text:
          'Deploy notes\n\nUse ghp_' +
          'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0 for the API.\n',
        title: 'Notes',
      },
      'note',
    );
    expect(r).toEqual({
      ok: false,
      reason: 'secret',
      message:
        'looks like it holds a GitHub token (line 3); remove it and add it again',
    });
    const file = path.join(root, 'conn.md');
    await fs.writeFile(
      file,
      '# Connection\n\nServer=db;Password=Sup3rSecretValue;Database=x\n',
    );
    const f = await addSource(git, dir, { file }, 'doc');
    expect(f.ok).toBe(false);
    if (f.ok) throw new Error('unexpected');
    expect(f.reason).toBe('secret');
    expect(await listSources(dir, null)).toEqual([]);
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('refuses a note that holds a credential', async () => {
    const r = await addSource(
      git,
      dir,
      {
        text: 'Plain text\n',
        title: 'Notes',
        note: 'token ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0',
      },
      'note',
    );
    expect(r).toEqual({
      ok: false,
      reason: 'secret',
      message:
        'the note looks like it holds a GitHub token; remove it and add it again',
    });
    expect(await listSources(dir, null)).toEqual([]);
    // A credential in the file keeps the file's own line number.
    const file = path.join(root, 'conn.md');
    await fs.writeFile(
      file,
      '# Connection\n\nServer=db;Password=Sup3rSecretValue;Database=x\n',
    );
    const f = await addSource(git, dir, { file, note: 'From ops' }, 'doc');
    expect(f).toMatchObject({ ok: false, reason: 'secret' });
    if (f.ok) throw new Error('unexpected');
    expect(f.message).toMatch(/^conn\.md: looks like it holds a .* \(line 3\)/);
  });
});

describe('removeSource', () => {
  const git = new GitClient();
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-remove-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('deletes the source, its original and assets, forgets the capture and commits those paths', async () => {
    const file = path.join(root, 'standup.vtt');
    await fs.writeFile(
      file,
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello from the standup\n',
    );
    const r = await addSource(git, dir, { file }, 'transcript');
    if (!r.ok) throw new Error(r.message);
    const other = await addSource(
      git,
      dir,
      { text: 'keep', title: 'Keep' },
      'note',
    );
    if (!other.ok) throw new Error(other.message);
    await writeState(dir, (s) => ({
      ...s,
      captured: {
        [r.path]: { at: 't', sessionId: null },
        [other.path]: { at: 't', sessionId: null },
      },
    }));
    await fs.writeFile(path.join(dir, 'wiki', 'hand.md'), 'uncommitted\n');
    await removeSource(git, dir, r.path);
    const left = (await listSources(dir, (await readState(dir)).state)).map(
      (s) => s.path,
    );
    expect(left).toEqual([other.path]);
    expect(await fs.readdir(path.join(dir, 'sources'))).not.toContain(
      path.basename(r.path).replace(/\.md$/, '.vtt'),
    );
    expect((await readState(dir)).state?.captured).toEqual({
      [other.path]: { at: 't', sessionId: null },
    });
    expect((await git.run(dir, ['log', '-1', '--format=%s'])).trim()).toBe(
      `Brain: remove source ${r.path}`,
    );
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe(
      '?? wiki/hand.md',
    );
  });

  it('removes the drop entry with the source and keeps the others', async () => {
    const mk = async (name: string) => {
      const f = path.join(root, name);
      await fs.writeFile(f, await deckWithPicture());
      const r = await addSource(git, dir, { file: f }, 'deck');
      if (!r.ok) throw new Error(r.message);
      return r.path;
    };
    const a = await mk('A.pptx');
    // A different deck, so it is not a duplicate.
    const b = await (async () => {
      const zip = await JSZip.loadAsync(await deckWithPicture());
      zip.file('ppt/media/image2.emf', Buffer.from([9, 9, 9]));
      const f = path.join(root, 'B.pptx');
      await fs.writeFile(f, await zip.generateAsync({ type: 'nodebuffer' }));
      const r = await addSource(git, dir, { file: f }, 'deck');
      if (!r.ok) throw new Error(r.message);
      return r.path;
    })();
    await removeSource(git, dir, a);
    const left = JSON.parse(
      await fs.readFile(path.join(dir, 'brain/pictures-dropped.json'), 'utf8'),
    );
    expect(Object.keys(left)).toEqual([b]);
    expect(
      await git.run(dir, ['show', '--stat', '--format=', 'HEAD']),
    ).toContain('brain/pictures-dropped.json');
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('leaves the drop file alone for a source without an entry', async () => {
    const r = await addSource(git, dir, { text: 'x', title: 'X' }, 'note');
    if (!r.ok) throw new Error(r.message);
    await removeSource(git, dir, r.path);
    expect(
      await git.run(dir, ['show', '--stat', '--format=', 'HEAD']),
    ).not.toContain('pictures-dropped');
  });

  it('refuses wiki mirror pages, paths outside sources/ and missing sources', async () => {
    await expect(
      removeSource(git, dir, 'sources/wiki/Page.md'),
    ).rejects.toThrow(/wiki mirror/);
    await expect(removeSource(git, dir, 'wiki/account.md')).rejects.toThrow(
      /outside the wiki mirror/,
    );
    await expect(
      removeSource(git, dir, 'sources/../SCHEMA.md'),
    ).rejects.toThrow(/outside the wiki mirror/);
    await expect(removeSource(git, dir, 'sources/none.md')).rejects.toThrow(
      /No source/,
    );
  });
});

describe('removeSource after review', () => {
  const git = new GitClient();
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-remove2-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('removes a source that was never committed, with its untracked original', async () => {
    await fs.writeFile(
      path.join(dir, 'sources', '2026-11-04-new.md'),
      '---\ntitle: New\nsource_url: new.vtt\ningested_at: 2026-11-04T10:00:00.000Z\ncontent_type: transcript\nsha256: x\n---\n\nnew\n',
    );
    await fs.writeFile(
      path.join(dir, 'sources', '2026-11-04-new.vtt'),
      'WEBVTT',
    );
    await fs.mkdir(path.join(dir, 'sources', '2026-11-04-new-assets'));
    await fs.writeFile(
      path.join(dir, 'sources', '2026-11-04-new-assets', 'p.png'),
      'x',
    );
    await removeSource(git, dir, 'sources/2026-11-04-new.md');
    expect(await fs.readdir(path.join(dir, 'sources'))).toEqual(['.gitkeep']);
    expect((await git.run(dir, ['log', '-1', '--format=%s'])).trim()).toBe(
      'Brain: remove source sources/2026-11-04-new.md',
    );
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('stops before deleting anything when brain/state.json is broken', async () => {
    const r = await addSource(
      git,
      dir,
      { text: 'keep', title: 'Keep' },
      'note',
    );
    if (!r.ok) throw new Error(r.message);
    await fs.writeFile(path.join(dir, 'brain', 'state.json'), '{bad');
    await expect(removeSource(git, dir, r.path)).rejects.toThrow(/state\.json/);
    expect(await fs.readdir(path.join(dir, 'sources'))).toContain(
      path.basename(r.path),
    );
  });
});

describe('removeSource without a state file', () => {
  it('recreates brain/state.json and commits', async () => {
    const git = new GitClient();
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-remove3-')),
    );
    const dir = path.join(root, 'brain');
    try {
      await scaffoldBrain(git, dir, 'Acme');
      const r = await addSource(
        git,
        dir,
        { text: 'gone', title: 'Gone' },
        'note',
      );
      if (!r.ok) throw new Error(r.message);
      await git.run(dir, ['rm', '-q', '--', 'brain/state.json']);
      await git.run(dir, ['commit', '-q', '-m', 'no state']);
      await removeSource(git, dir, r.path);
      expect((await readState(dir)).state).not.toBeNull();
      expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('removeSource with a non-ASCII name', () => {
  it('removes a committed source whose name has a space and an accent', async () => {
    const git = new GitClient();
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-remove4-')),
    );
    const dir = path.join(root, 'brain');
    try {
      await scaffoldBrain(git, dir, 'Acme');
      await fs.mkdir(path.join(dir, 'sources', 'sub'));
      await fs.writeFile(
        path.join(dir, 'sources', 'sub', 'x y é.md'),
        '---\ntitle: X\nsource_url: x.pdf\ningested_at: 2026-11-04T10:00:00.000Z\ncontent_type: doc\nsha256: x\n---\n\nx\n',
      );
      await fs.writeFile(path.join(dir, 'sources', 'sub', 'x y é.pdf'), 'pdf');
      await git.run(dir, ['add', '-A']);
      await git.run(dir, ['commit', '-q', '-m', 'Brain: sync']);
      await removeSource(git, dir, 'sources/sub/x y é.md');
      expect(await fs.readdir(path.join(dir, 'sources', 'sub'))).toEqual([]);
      expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
      expect((await git.run(dir, ['log', '-1', '--format=%s'])).trim()).toBe(
        'Brain: remove source sources/sub/x y é.md',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
