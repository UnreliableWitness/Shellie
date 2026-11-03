import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitClient } from '../services/GitClient';
import { scaffoldBrain } from './scaffold';
import { addSource, listSources } from './sources';

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
<v Ann>Welcome to the kickoff.
`;

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
    expect(r).toEqual({ ok: true, path: 'sources/2026-11-03-note.md' });
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

  it('copies the original beside a converted file', async () => {
    const f = path.join(root, 'Kickoff.vtt');
    await fs.writeFile(f, VTT);
    const r = await addSource(git, dir, { file: f }, 'transcript', now);
    expect(r).toEqual({ ok: true, path: 'sources/2026-11-03-kickoff.md' });
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
      message: 'No text layer; needs OCR',
    });
    expect(await fs.readdir(path.join(dir, 'sources'))).toEqual(['.gitkeep']);
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
});
