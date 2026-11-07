import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrainSchema, type Brain } from '../../shared/brain';
import { BrainStore } from './BrainStore';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-store-'));
  file = path.join(dir, 'brains.json');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const brain = (id: string, project: string): Brain =>
  BrainSchema.parse({
    id,
    name: project,
    connectionId: 'c1',
    project,
    path: `/x/${id}`,
    createdAt: 't',
  });

describe('BrainStore', () => {
  it('adds, patches, finds by project and removes', async () => {
    const s = new BrainStore(file);
    await s.load();
    await s.add(brain('b1', 'Acme'));
    await s.add(brain('b2', 'Beta'));
    expect(s.forProject('c1', 'Acme').map((b) => b.id)).toEqual(['b1']);
    expect(s.get('b2')?.project).toBe('Beta');
    const patched = await s.patch('b1', { name: 'Renamed' });
    expect(patched.name).toBe('Renamed');

    const again = new BrainStore(file);
    await again.load();
    expect(again.get('b1')?.name).toBe('Renamed');

    await s.remove('b1');
    expect(s.list()).toHaveLength(1);
  });
  it('reads a brains.json written before the picture pass with no pass', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        brains: [
          {
            id: 'b1',
            name: 'Acme',
            connectionId: 'c1',
            project: 'Acme',
            path: '/x/b1',
            createdAt: 't',
            templatesVersion: 5,
          },
        ],
      }),
    );
    const s = new BrainStore(file);
    await s.load();
    expect(s.get('b1')?.picturePass).toBeNull();
  });
  it('loads an empty list when the file is missing', async () => {
    const s = new BrainStore(file);
    await s.load();
    expect(s.list()).toEqual([]);
  });
  it('patch rejects an unknown id', async () => {
    const s = new BrainStore(file);
    await s.load();
    await expect(s.patch('nope', { name: 'x' })).rejects.toThrow(/nope/);
  });
});

describe('archived brains', () => {
  it('are kept in the list but are not any project task brain', async () => {
    const s = new BrainStore(file);
    await s.load();
    await s.add(brain('a', 'P'));
    await s.add(brain('b', 'P'));
    await s.patch('a', { archived: true });
    expect(s.list().map((b) => [b.id, b.archived])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    expect(s.forProject('c1', 'P').map((b) => b.id)).toEqual(['b']);
    await s.patch('a', { archived: false });
    expect(s.forProject('c1', 'P').map((b) => b.id)).toEqual(['a', 'b']);
  });

  it("archiveByConnection archives only that connection's brains and returns their ids", async () => {
    const s = new BrainStore(file);
    await s.load();
    await s.add(brain('a', 'P'));
    await s.add(brain('b', 'Q'));
    await s.add({ ...brain('c', 'R'), connectionId: 'c2' });
    await s.add({ ...brain('d', 'S'), archived: true });
    expect(await s.archiveByConnection('c1')).toEqual(['a', 'b']);
    expect(s.list().map((b) => [b.id, b.archived])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
      ['d', true],
    ]);
    expect(await s.archiveByConnection('c1')).toEqual([]);
    const again = new BrainStore(file);
    await again.load();
    expect(again.get('a')?.archived).toBe(true);
  });
});
