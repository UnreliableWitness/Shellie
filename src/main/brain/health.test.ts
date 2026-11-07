import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CostRecord } from '../../shared/ledger';
import { GitClient } from '../services/GitClient';
import { brainHealth, ledgerToday } from './health';
import { scaffoldBrain } from './scaffold';
import { addSource } from './sources';
import { writeState } from './state';

describe('brainHealth', () => {
  const git = new GitClient();
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-health-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  };
  const commit = async (message: string) => {
    await git.run(dir, ['add', '-A']);
    await git.run(dir, ['commit', '-m', message]);
  };
  const today = { tokens: 1200, costEur: 0.5 };

  it('reports a fresh brain as clean', async () => {
    const h = await brainHealth(dir, git, today, false);
    expect(h).toMatchObject({
      uncaptured: 0,
      mirrorPages: 0,
      outsideEdits: [],
      queuePaused: null,
      tokensToday: 1200,
      costEurToday: 0.5,
    });
    expect(h.state).not.toBeNull();
    expect(h.stateError).toBeNull();
  });

  it('counts uncaptured sources and mirror pages', async () => {
    const a = await addSource(git, dir, { text: 'a', title: 'A' }, 'note');
    await addSource(git, dir, { text: 'b', title: 'B' }, 'note');
    await write(
      'sources/wiki/Page.md',
      '---\ntitle: Page\nsource_url: https://x\ningested_at: 2026-11-03T09:00:00.000Z\ncontent_type: wiki-page\nsha256: x\n---\n\nPage\n',
    );
    await commit('Brain: refresh wiki mirror (+1 ~0 -0)');
    if (!a.ok) throw new Error('add failed');
    await writeState(dir, (s) => ({
      ...s,
      captured: { [a.path]: { at: 't', sessionId: null } },
    }));
    const h = await brainHealth(dir, git, today, true);
    expect(h.uncaptured).toBe(1);
    expect(h.mirrorPages).toBe(1);
    expect(h.queuePaused).toBe('cap');
  });

  it('lists wiki files edited outside a Brain: commit since the last sync, and uncommitted ones', async () => {
    await write('wiki/old.md', 'old\n');
    await commit('hand edit before');
    await write('wiki/kept.md', 'kept\n');
    await commit('Brain: sync');
    await write('wiki/a.md', 'a\n');
    await write('wiki/sub/b.md', 'b\n');
    await commit('Fix a typo');
    // A capture after an outside edit does not hide it.
    await write('wiki/captured.md', 'by the agent\n');
    await commit('Brain: capture sources/x.md');
    await write('wiki/c.md', 'c\n');
    await write('wiki/kept.md', 'kept, edited\n');
    await write('notes.md', 'outside wiki\n');
    const h = await brainHealth(dir, git, today, false);
    expect(h.outsideEdits.sort()).toEqual([
      'wiki/a.md',
      'wiki/c.md',
      'wiki/kept.md',
      'wiki/sub/b.md',
    ]);
  });

  it("merges Shellie's own findings with the lint's, dropping the kinds Shellie computes", async () => {
    const a = await addSource(git, dir, { text: 'a', title: 'A' }, 'note');
    if (!a.ok) throw new Error('add failed');
    await write(
      'wiki/account.md',
      `---\ntitle: Acme\nsummary: Who.\nsources: [${a.path}]\nlast_updated: 2020-01-01\n---\n[gone](missing.md)\n`,
    );
    await write('wiki/thin.md', '# Thin\n');
    const at = '2026-11-02T10:00:00.000Z';
    await writeState(dir, (s) => ({
      ...s,
      findings: [
        { kind: 'orphan', page: 'wiki/x.md', detail: 'old lint', at },
        { kind: 'broken-link', page: 'wiki/x.md', detail: 'old lint', at },
        { kind: 'contradiction', page: 'wiki/account.md', detail: 'dates', at },
        { kind: 'scope-change', page: 'wiki/scope-a.md', detail: 'rate', at },
      ],
    }));
    const now = new Date('2026-11-04T12:00:00Z');
    const h = await brainHealth(dir, git, today, false, now);
    expect(h.pages).toBe(2);
    expect(h.findings.map((f) => [f.kind, f.page])).toEqual([
      ['broken-link', 'wiki/account.md'],
      ['stale', 'wiki/account.md'],
      ['frontmatter', 'wiki/thin.md'],
      ['uncaptured', a.path],
      ['contradiction', 'wiki/account.md'],
      ['scope-change', 'wiki/scope-a.md'],
    ]);
    expect(h.findings[0].at).toBe(now.toISOString());
    expect(h.findings[4].at).toBe(at);
    expect(h.uncaptured).toBe(1);
  });

  it('counts pictures over all sources, with one finding per source with gaps', async () => {
    const fresh = await brainHealth(dir, git, today, false);
    expect(fresh.pictures).toEqual({
      total: 0,
      described: 0,
      skipped: 0,
      missing: 0,
      dropped: 0,
      accepted: 0,
      tiny: 0,
    });
    const a = await addSource(git, dir, { text: 'a', title: 'A' }, 'note');
    if (!a.ok) throw new Error('add failed');
    const assets = a.path.replace(/\.md$/, '-assets');
    await write(`${assets}/slide-1.png`, 'png');
    await write(`${assets}/slide-2.png`, 'png');
    await write(
      'wiki/account.md',
      `---\ntitle: Acme\nsummary: Who.\nsources: [${a.path}]\n---\n![s1](../${assets}/slide-1.png)\n`,
    );
    await write(
      'brain/pictures-dropped.json',
      JSON.stringify({
        [a.path]: {
          dropped: [{ where: 'slide 3', reason: 'r', fix: 'f', accepted: 't' }],
          tiny: 4,
        },
      }),
    );
    const now = new Date('2026-11-07T12:00:00Z');
    const h = await brainHealth(dir, git, today, false, now);
    expect(h.pictures).toEqual({
      total: 3,
      described: 1,
      skipped: 0,
      missing: 1,
      dropped: 0,
      accepted: 1,
      tiny: 4,
    });
    expect(h.findings.filter((f) => f.kind === 'picture')).toEqual([
      {
        kind: 'picture',
        page: a.path,
        detail: '1 picture not interpreted',
        at: now.toISOString(),
      },
    ]);
  });

  it('reports a broken state file without failing', async () => {
    await write('brain/state.json', '{not json');
    const h = await brainHealth(dir, git, today, false);
    expect(h.state).toBeNull();
    expect(h.stateError).toMatch(/state\.json/);
  });
});

describe('ledgerToday', () => {
  const rec = (over: Partial<CostRecord>): CostRecord =>
    ({
      id: 'r',
      at: '2026-11-03T10:00:00',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheWrite5mTokens: 1,
      cacheWrite1hTokens: 2,
      costEur: 0.25,
      attribution: {
        level: 'brain',
        brainId: 'b1',
        organization: 'o',
        project: 'p',
      },
      ...over,
    }) as CostRecord;

  it("sums the brain's tokens and euros of today's local date", () => {
    const now = new Date('2026-11-03T15:00:00');
    const total = ledgerToday(
      [
        rec({}),
        rec({ id: 'r2', costEur: null }),
        rec({ id: 'r3', at: '2026-11-02T23:00:00' }),
        rec({
          id: 'r4',
          attribution: {
            level: 'brain',
            brainId: 'b2',
            organization: 'o',
            project: 'p',
          },
        }),
        rec({ id: 'r5', attribution: { level: 'none' } }),
      ],
      'b1',
      now,
    );
    expect(total).toEqual({ tokens: 236, costEur: 0.25 });
  });
});
