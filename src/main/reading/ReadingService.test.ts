import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrainSchema, type Brain } from '../../shared/brain';
import type { ReaderMarkSet } from '../../shared/reader';
import { ReadingService, type ReadingWorkItem } from './ReadingService';

let root: string;
const write = async (dir: string, rel: string, text: string) => {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};
const longRead = (title: string, summary: string, pages: string[]) =>
  [
    '---',
    `title: ${title}`,
    `summary: ${summary}`,
    'chapter: Returns',
    'pages:',
    ...pages.map((p) => `  - ${p}`),
    'written: 2026-11-09',
    '---',
    '',
    `# ${title}`,
    '',
    'A return is a promise kept twice.',
    '',
  ].join('\n');
const brain = (id: string, over: Partial<Brain> = {}): Brain =>
  BrainSchema.parse({
    id,
    name: `Brain ${id}`,
    connectionId: 'c1',
    project: 'Acme',
    path: path.join(root, id),
    createdAt: '2026-11-01T09:00:00.000Z',
    ...over,
  });
const item = (over: Partial<ReadingWorkItem> = {}): ReadingWorkItem => ({
  connectionId: 'c1',
  project: 'Acme',
  id: '412',
  title: 'Return flow: refund before receipt',
  ...over,
});

async function fill(id: string) {
  const dir = path.join(root, id);
  await write(
    dir,
    'reads/returns.md',
    longRead('How a return travels', 'From the customer back.', [
      'wiki/subject-returns.md',
    ]),
  );
  await write(
    dir,
    'wiki/subject-returns.md',
    '---\ntitle: Returns\nsummary: The return flow.\n---\n\n# Returns\n\nA return.\n',
  );
  await write(
    dir,
    'brain/book.json',
    JSON.stringify({
      chapters: [
        { title: 'Returns', summary: 's', pages: ['wiki/subject-returns.md'] },
        { title: 'Empty', summary: 's', pages: [] },
      ],
    }),
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-reading-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('ReadingService', () => {
  it('lists a brain with its chapters, long reads, marks and the work they bear on', async () => {
    await fill('b1');
    const mark = { hash: 'h', at: '2026-11-10T09:00:00.000Z', read: true };
    const service = new ReadingService({
      brains: () => [brain('b1')],
      workItems: async () => [item()],
      marks: (id): ReaderMarkSet =>
        id === 'b1' ? { 'reads/returns.md': mark } : {},
    });
    const [b, ...rest] = await service.list();
    expect(rest).toEqual([]);
    expect(b).toMatchObject({
      brainId: 'b1',
      name: 'Brain b1',
      connectionId: 'c1',
      chapters: ['Returns'],
      letters: [],
      marks: { 'reads/returns.md': mark },
    });
    expect(b.reads).toMatchObject([
      {
        path: 'reads/returns.md',
        title: 'How a return travels',
        chapter: 'Returns',
        work: [{ id: 412, title: 'Return flow: refund before receipt' }],
      },
    ]);
  });

  it('leaves out archived brains, brains without a long read or letter and folders that cannot be read', async () => {
    await fill('b1');
    await fill('old');
    await fs.mkdir(path.join(root, 'empty'), { recursive: true });
    const service = new ReadingService({
      brains: () => [
        brain('old', { archived: true }),
        brain('empty'),
        brain('gone'),
        brain('b1'),
      ],
      workItems: async () => [],
      marks: () => ({}),
    });
    expect((await service.list()).map((b) => b.brainId)).toEqual(['b1']);
  });

  it("matches work of the brain's own connection and project only, and skips ids that are not numbers", async () => {
    await fill('b1');
    const service = new ReadingService({
      brains: () => [brain('b1')],
      workItems: async () => [
        item({ connectionId: 'c2' }),
        item({ project: 'Other' }),
        item({ id: 'ABC-1' }),
      ],
      marks: () => ({}),
    });
    expect((await service.list())[0].reads[0].work).toBeUndefined();
    expect(await service.work(brain('b1'))).toEqual({});
  });

  it('still lists when the work cannot be had', async () => {
    await fill('b1');
    const service = new ReadingService({
      brains: () => [brain('b1')],
      workItems: async () => {
        throw new Error('no home');
      },
      marks: () => ({}),
    });
    expect((await service.list())[0].reads).toHaveLength(1);
  });

  it('gives the phone the same links', async () => {
    await fill('b1');
    const service = new ReadingService({
      brains: () => [brain('b1')],
      workItems: async () => [item()],
      marks: () => ({}),
    });
    expect(await service.work(brain('b1'))).toEqual({
      'reads/returns.md': [
        { id: 412, title: 'Return flow: refund before receipt' },
      ],
    });
  });

  it('keeps what it read of a brain until the brain changes or five minutes pass', async () => {
    await fill('b1');
    let now = 0;
    const service = new ReadingService({
      brains: () => [brain('b1')],
      workItems: async () => [],
      marks: () => ({}),
      now: () => now,
    });
    const titles = async () =>
      (await service.list())[0].reads.map((r) => r.title);
    expect(await titles()).toEqual(['How a return travels']);
    await write(
      path.join(root, 'b1'),
      'reads/returns.md',
      longRead('Returns, rewritten', 's', ['wiki/subject-returns.md']),
    );
    expect(await titles()).toEqual(['How a return travels']);
    service.brainChanged('b1');
    expect(await titles()).toEqual(['Returns, rewritten']);

    await write(
      path.join(root, 'b1'),
      'reads/returns.md',
      longRead('Returns, once more', 's', ['wiki/subject-returns.md']),
    );
    now = 4 * 60_000;
    expect(await titles()).toEqual(['Returns, rewritten']);
    now = 6 * 60_000;
    expect(await titles()).toEqual(['Returns, once more']);
  });
});
