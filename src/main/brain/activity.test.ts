import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityText } from '../../shared/brainShare';
import { GitClient } from '../services/GitClient';
import { brainActivity } from './activity';
import {
  INDEX_MESSAGE,
  JOIN_MESSAGE,
  MERGE_MESSAGE,
  SHARE_MESSAGE,
} from './brainCommits';
import { scaffoldBrain } from './scaffold';
import { OUTSIDE_EDIT_MESSAGE } from './scrub';

// real git, many subprocesses per test: slow under load and on the Windows runner
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('brainActivity', () => {
  const git = new GitClient();
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-activity-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  let tick = 0;
  /** Writes the files and commits them as a person; each commit a minute after the last, so the order is fixed. */
  const commit = async (
    message: string,
    files: Record<string, string>,
    by: { name: string; email: string } = {
      name: 'Dries',
      email: 'me@install.shellie',
    },
  ) => {
    for (const [rel, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text);
    }
    await git.run(dir, ['add', '-A']);
    const date = new Date(Date.UTC(2026, 10, 27, 9, tick++)).toISOString();
    await git.run(
      dir,
      [
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        message,
        `--author=${by.name} <${by.email}>`,
      ],
      { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
    );
  };
  const anna = { name: 'Anna', email: 'her@install.shellie' };
  const lines = async (installId: string | null = 'me') =>
    (await brainActivity(git, dir, { installId })).map(
      (e) =>
        `${e.me ? 'You' : e.who} ${activityText(e)}${e.pages.length ? ` [${e.pages.map((p) => `${p.added ? '+' : ''}${p.path}`).join(' ')}]` : ''}`,
    );

  it('tells who added, captured and wrote what, newest first, without the housekeeping', async () => {
    await commit(SHARE_MESSAGE, { 'brain/origin.json': '{}' });
    await commit(JOIN_MESSAGE, { 'brain/members.json': '[]' }, anna);
    await commit(
      'Brain: add source plan.md',
      { 'sources/plan.md': 'plan' },
      anna,
    );
    await commit(
      'Brain: capture sources/plan.md',
      { 'wiki/plan.md': '# Plan', 'wiki/index.md': '# Index', 'log.md': 'x' },
      anna,
    );
    await commit(INDEX_MESSAGE, { 'wiki/index.md': '# Index 2' }, anna);
    await commit(MERGE_MESSAGE, { 'brain/state.json': '{"a":1}' });
    await commit('Brain: lint', { 'brain/state.json': '{"a":2}' });
    await commit(OUTSIDE_EDIT_MESSAGE, { 'wiki/plan.md': '# Plan, edited' });
    await commit('Brain: write reads/onboarding.md', {
      'reads/onboarding.md': '# Onboarding',
    });
    await commit('Brain: remove source plan.md', {}, anna);

    expect(await lines()).toEqual([
      'Anna removed plan.md',
      'You wrote the long read onboarding.md [+reads/onboarding.md]',
      'You edited pages by hand [wiki/plan.md]',
      'Anna turned plan.md into pages [+wiki/plan.md]',
      'Anna added plan.md',
      'Anna joined the brain',
      'You shared the brain',
      // The scaffold's own commit; a shared brain's history starts at the share, so it is only seen in a local one.
      'Shellie started the brain',
    ]);
  });

  it('counts every commit of a local brain as this person', async () => {
    await commit('Brain: add source a.md', { 'sources/a.md': 'a' }, anna);
    expect((await lines(null))[0]).toBe('You added a.md');
  });

  it('names at most six pages and counts the rest', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) files[`wiki/p${i}.md`] = `# ${i}`;
    await commit('Brain: capture sources/big.md', files, anna);
    const [e] = await brainActivity(git, dir, { installId: 'me' });
    expect(e.pages).toHaveLength(6);
    expect(e.morePages).toBe(3);
  });
});
