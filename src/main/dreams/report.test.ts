import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DreamReportSchema,
  groupProposals,
  readReport,
  splitAllowed,
  type DreamReport,
} from './report';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-report-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const proposal = (
  over: Partial<DreamReport['proposals'][number]> = {},
): DreamReport['proposals'][number] => ({
  kind: 'new-rule',
  title: 'T',
  why: 'W',
  evidence: [{ task: 't1', date: '2026-11-01', quote: 'q' }],
  files: ['r.md'],
  ...over,
});
const report = (proposals: DreamReport['proposals']): DreamReport => ({
  proposals,
  sightings: [],
});

describe('readReport', () => {
  const msg = 'The dream left no readable report';
  it('throws on a missing file', async () => {
    await expect(readReport(dir)).rejects.toThrow(msg);
  });
  it('throws on not json', async () => {
    await fs.writeFile(path.join(dir, 'report.json'), 'not json');
    await expect(readReport(dir)).rejects.toThrow(msg);
  });
  it('throws on the wrong shape', async () => {
    await fs.writeFile(
      path.join(dir, 'report.json'),
      JSON.stringify({ proposals: 'x' }),
    );
    await expect(readReport(dir)).rejects.toThrow(msg);
  });
  it('reads a good report and collapses line breaks', async () => {
    await fs.writeFile(
      path.join(dir, 'report.json'),
      JSON.stringify({
        proposals: [
          proposal({
            title: 'a\nb\r\nc',
            evidence: [{ task: 't\n1', date: 'd\n', quote: 'q\nq' }],
          }),
        ],
        sightings: [{ note: 'n\nm', task: 't', quote: 'q' }],
      }),
    );
    const r = await readReport(dir);
    expect(r.proposals[0].title).toBe('a b c');
    expect(r.proposals[0].evidence[0].task).toBe('t 1');
    expect(r.proposals[0].evidence[0].quote).toBe('q\nq');
    expect(r.sightings[0].note).toBe('n m');
  });
});

describe('DreamReportSchema bounds', () => {
  const ok = (p: Partial<DreamReport['proposals'][number]>) =>
    DreamReportSchema.safeParse(report([proposal(p)])).success;
  it('bounds the text', () => {
    expect(ok({ title: 'x'.repeat(201) })).toBe(false);
    expect(ok({ why: 'x'.repeat(1001) })).toBe(false);
    expect(
      ok({ evidence: [{ task: 't', date: 'd', quote: 'x'.repeat(501) }] }),
    ).toBe(false);
    expect(
      ok({
        evidence: Array.from({ length: 11 }, () => ({
          task: 't',
          date: 'd',
          quote: 'q',
        })),
      }),
    ).toBe(false);
  });
  it('bounds the counts', () => {
    expect(
      DreamReportSchema.safeParse(
        report(Array.from({ length: 11 }, () => proposal())),
      ).success,
    ).toBe(false);
    expect(
      DreamReportSchema.safeParse({
        proposals: [],
        sightings: Array.from({ length: 51 }, () => ({
          note: 'n',
          task: 't',
          quote: 'q',
        })),
      }).success,
    ).toBe(false);
  });
  it.each(['/abs.md', '../x.md', 'a/../b.md', 'C:\\x.md', 'a\\..\\b'])(
    'rejects file %j',
    (f) => {
      expect(ok({ files: [f] })).toBe(false);
    },
  );
});

describe('splitAllowed', () => {
  it('splits by folder and normalises separators', () => {
    expect(
      splitAllowed(['.apm/skills/a/SKILL.md', 'src/x.ts', '.apmx/y'], ['.apm']),
    ).toEqual({
      allowed: ['.apm/skills/a/SKILL.md'],
      outside: ['src/x.ts', '.apmx/y'],
    });
    expect(
      splitAllowed(['.apm\\skills\\a.md', './.apm/b.md'], ['.apm']),
    ).toEqual({
      allowed: ['.apm/skills/a.md', '.apm/b.md'],
      outside: [],
    });
  });
  it('allows a file entry itself but not a sibling prefix', () => {
    expect(
      splitAllowed(
        ['AGENTS.md', 'AGENTS.md2', 'a/b', 'a/bc'],
        ['AGENTS.md', 'a/b'],
      ),
    ).toEqual({
      allowed: ['AGENTS.md', 'a/b'],
      outside: ['AGENTS.md2', 'a/bc'],
    });
  });
  it('compares exactly, case-sensitively', () => {
    expect(splitAllowed(['.APM/x'], ['.apm']).outside).toEqual(['.APM/x']);
  });
  it('lets an empty or . folder allow nothing', () => {
    expect(splitAllowed(['a.md', 'OpenCode.json'], ['.', ''])).toEqual({
      allowed: [],
      outside: ['a.md', 'OpenCode.json'],
    });
  });
  it('never allows a protected path', () => {
    expect(
      splitAllowed(
        [
          '.apm/.opencode/plugin/x.ts',
          'OpenCode.json',
          '.apm/hooks/format.json',
          '.apm/HOOKS/run.sh',
          '.apm/ok.md',
        ],
        ['.apm', '.'],
      ),
    ).toEqual({
      allowed: ['.apm/ok.md'],
      outside: [
        '.apm/.opencode/plugin/x.ts',
        'OpenCode.json',
        '.apm/hooks/format.json',
        '.apm/HOOKS/run.sh',
      ],
    });
  });
});

describe('groupProposals', () => {
  it('merges transitively: a bridging proposal joins both groups', () => {
    const r = groupProposals(
      report([
        proposal({ title: 'A', kind: 'new-skill', files: ['a.md'] }),
        proposal({ title: 'B', files: ['c.md'] }),
        proposal({ title: 'C', files: ['a.md', 'c.md'] }),
      ]),
      ['a.md', 'c.md'],
      false,
    );
    expect(r.groups.map((g) => g.title)).toEqual(['A + B + C']);
    expect(r.groups[0].kind).toBe('new-skill');
    expect(r.groups[0].files).toEqual(['a.md', 'c.md']);
    expect(r.groups[0].evidence).toHaveLength(3);
    const all = r.groups.flatMap((g) => g.files);
    expect(new Set(all).size).toBe(all.length);
  });
  it('fails everything when a check ran and wrote no verdicts', () => {
    const r = groupProposals(report([proposal()]), ['r.md'], true);
    expect(r.groups).toEqual([]);
    expect(r.unlisted).toEqual(['r.md']);
    expect(r.removedByCheck).toBe(1);
  });
  it('caps a merged title and why', () => {
    const r = groupProposals(
      report([
        proposal({ title: 'x'.repeat(200), why: 'y'.repeat(1000) }),
        proposal({ title: 'z'.repeat(200), why: 'w'.repeat(1000) }),
      ]),
      ['r.md'],
      false,
    );
    expect(r.groups[0].title).toHaveLength(200);
    expect(r.groups[0].title.endsWith('…')).toBe(true);
    expect(r.groups[0].why).toHaveLength(1000);
    expect(r.groups[0].why.endsWith('…')).toBe(true);
  });
  it('drops a failed proposal and leaves its files unlisted', () => {
    const r = groupProposals(
      report([
        proposal({ title: 'A', files: ['a.md'], verdict: 'pass' }),
        proposal({ title: 'B', files: ['b.md'], verdict: 'fail' }),
      ]),
      ['a.md', 'b.md'],
      true,
    );
    expect(r.groups.map((g) => g.title)).toEqual(['A']);
    expect(r.unlisted).toEqual(['b.md']);
    expect(r.removedByCheck).toBe(1);
  });
  it('merges proposals sharing a file', () => {
    const r = groupProposals(
      report([
        proposal({ title: 'A', kind: 'new-skill', files: ['r.md', 'a.md'] }),
        proposal({ title: 'B', kind: 'new-rule', files: ['r.md'] }),
        proposal({ title: 'C', files: ['c.md'] }),
      ]),
      ['r.md', 'a.md', 'c.md'],
      false,
    );
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0].title).toBe('A + B');
    expect(r.groups[0].kind).toBe('new-skill');
    expect(r.groups[0].files).toEqual(['r.md', 'a.md']);
    expect(r.groups[0].evidence).toHaveLength(2);
    expect(r.groups[1].title).toBe('C');
    expect(r.unlisted).toEqual([]);
  });
  it('drops unchanged files and removes a proposal left with none', () => {
    const r = groupProposals(
      report([
        proposal({ title: 'A', files: ['a.md', 'gone.md'] }),
        proposal({ title: 'B', files: ['gone2.md'] }),
      ]),
      ['a.md'],
      false,
    );
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].files).toEqual(['a.md']);
    expect(r.removedByCheck).toBe(1);
  });
  it('lists changed files nobody lists as unlisted', () => {
    const r = groupProposals(report([proposal()]), ['r.md', 'stray.md'], false);
    expect(r.unlisted).toEqual(['stray.md']);
  });
  it('counts a proposal without a verdict as failed after a check run', () => {
    const r = groupProposals(
      report([proposal({ verdict: 'pass' }), proposal({ files: ['b.md'] })]),
      ['r.md', 'b.md'],
      true,
    );
    expect(r.groups).toHaveLength(1);
    expect(r.unlisted).toEqual(['b.md']);
    expect(r.removedByCheck).toBe(1);
  });
  it('treats no verdict anywhere as no check run', () => {
    const r = groupProposals(report([proposal()]), ['r.md'], false);
    expect(r.groups).toHaveLength(1);
    expect(r.removedByCheck).toBe(0);
  });
  it('keeps the first 3 that pass and counts the rest as removed', () => {
    const ps = ['a', 'b', 'c', 'd', 'e'].map((x) =>
      proposal({ title: x, files: [`${x}.md`], verdict: 'pass' }),
    );
    const r = groupProposals(
      report(ps),
      ps.flatMap((p) => p.files),
      true,
    );
    expect(r.groups.map((g) => g.title)).toEqual(['a', 'b', 'c']);
    expect(r.unlisted).toEqual(['d.md', 'e.md']);
    expect(r.removedByCheck).toBe(2);
  });
});
