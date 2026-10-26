import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.mjs';
import { runNotify } from './notify.mjs';
import { parseStatus, renderStatus } from './state.mjs';

const bot = 'shellie-agents[bot]';
const now = new Date('2026-10-26T12:00:00Z');

function fake(
  o: {
    state?: string;
    mergedAt?: string;
    releases?: { tag_name: string; published_at: string; contains: boolean }[];
  } = {},
) {
  const writes: string[] = [];
  const issue = {
    number: 4,
    state: o.state ?? 'closed',
    labels: [{ name: 'agent:merged' }],
    user: { login: 'maximedebraekeleer' },
  };
  const comments: Record<
    number,
    { id: number; user: { login: string }; body: string; created_at: string }[]
  > = {
    4: [
      {
        id: 1,
        user: { login: bot },
        body: renderStatus(
          {
            v: 1,
            state: 'merged',
            mergeSha: 'm1',
            mergedAt: o.mergedAt ?? '2026-10-26T11:30:00Z',
            pr: 9,
          },
          'x',
        ),
        created_at: '',
      },
    ],
  };
  const releases = o.releases ?? [];
  return {
    writes,
    issue,
    comments,
    async listIssuesByLabel() {
      return [issue];
    },
    async listComments(n: number) {
      return comments[n];
    },
    async comment(n: number, body: string) {
      writes.push(`comment #${n}: ${body}`);
      comments[n].push({ id: 99, user: { login: bot }, body, created_at: '' });
      return { id: 99 };
    },
    async editComment(id: number, body: string) {
      for (const c of comments[4]) if (c.id === id) c.body = body;
    },
    async addLabels(n: number, labels: string[]) {
      writes.push(`label #${n} +${labels.join(',')}`);
      for (const name of labels) issue.labels.push({ name });
    },
    async removeLabel(n: number, label: string) {
      writes.push(`label #${n} -${label}`);
      issue.labels = issue.labels.filter((l) => l.name !== label);
    },
    async close(n: number) {
      writes.push(`close #${n}`);
    },
    files: ['src/main/a.ts'],
    async commitFiles() {
      return this.files;
    },
    async listReleases() {
      return releases.map(({ tag_name, published_at }) => ({
        tag_name,
        published_at,
        draft: false,
      }));
    },
    async compare(base: string, head: string) {
      return {
        status: releases.find((r) => r.tag_name === head)?.contains
          ? 'ahead'
          : 'behind',
      };
    },
  };
}
const opts = (gh: ReturnType<typeof fake>, mode = 'full') => ({
  gh,
  config: parseConfig(''),
  mode,
  now,
  summary: () => {},
});
const statusOf = (gh: ReturnType<typeof fake>) =>
  parseStatus(gh.comments[4][0].body);

describe('runNotify', () => {
  it('tells the reporter the first release that has the fix, and closes the issue', async () => {
    const gh = fake({
      state: 'open',
      releases: [
        {
          tag_name: 'v1.54.0',
          published_at: '2026-10-26T11:50:00Z',
          contains: true,
        },
        {
          tag_name: 'v1.53.0',
          published_at: '2026-10-26T11:40:00Z',
          contains: true,
        },
        {
          tag_name: 'v1.52.0',
          published_at: '2026-10-26T07:30:00Z',
          contains: false,
        },
      ],
    });
    await runNotify(opts(gh) as never);
    const comment = gh.writes.find((w) => w.startsWith('comment #4'))!;
    expect(comment).toContain('Fixed in **v1.53.0**');
    expect(comment).toContain(
      'Shellie updates itself within about half an hour',
    );
    expect(gh.writes).toEqual(
      expect.arrayContaining([
        'label #4 +agent:released',
        'label #4 -agent:merged',
        'close #4',
      ]),
    );
    expect(statusOf(gh)).toMatchObject({
      state: 'released',
      release: 'v1.53.0',
    });
  });

  it('does not close an issue that is already closed', async () => {
    const gh = fake({
      releases: [
        {
          tag_name: 'v1.53.0',
          published_at: '2026-10-26T11:40:00Z',
          contains: true,
        },
      ],
    });
    await runNotify(opts(gh) as never);
    expect(gh.writes).not.toContain('close #4');
  });

  it('waits for the next bundled release, and hands over to the owner once a release was missed (26 h)', async () => {
    const gh = fake({ mergedAt: '2026-10-25T13:00:00Z' });
    await runNotify(opts(gh) as never);
    expect(gh.writes).toEqual([]);
    const late = fake({ mergedAt: '2026-10-25T09:00:00Z' });
    await runNotify(opts(late) as never);
    await runNotify(opts(late) as never);
    expect(
      late.writes.filter((w) => w === 'label #4 +agent:needs-owner'),
    ).toHaveLength(1);
    expect(late.writes.filter((w) => w.startsWith('comment #4'))).toHaveLength(
      1,
    );
  });

  it('is off in shadow and triage modes', async () => {
    const gh = fake({
      releases: [
        {
          tag_name: 'v1.53.0',
          published_at: '2026-10-26T11:40:00Z',
          contains: true,
        },
      ],
    });
    await runNotify(opts(gh, 'triage') as never);
    expect(gh.writes).toEqual([]);
  });

  it('closes a fix without app changes at once: there is no new version to wait for', async () => {
    const gh = fake({ state: 'open', mergedAt: '2026-10-26T10:00:00Z' });
    gh.files = [
      'src/main/ipc/handlers.part1.test.ts',
      'docs/changes/2026-10-26-x.md',
    ];
    await runNotify(opts(gh) as never);
    const comment = gh.writes.find((w) => w.startsWith('comment #4'))!;
    expect(comment).toContain('no new version');
    expect(gh.writes).toEqual(
      expect.arrayContaining([
        'label #4 +agent:released',
        'label #4 -agent:merged',
        'close #4',
      ]),
    );
    expect(gh.writes).not.toContain('label #4 +agent:needs-owner');
  });
});
