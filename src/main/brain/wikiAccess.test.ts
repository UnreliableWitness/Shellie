import { describe, expect, it } from 'vitest';
import type { BrainJob, BrainWiki } from '../../shared/brain';
import { jobTelemetry, pagesBucket, sizeBucket } from './brainTelemetry';
import { mirrorAuthFor, rootGitItemPath, wikiPageUrl } from './wikiAccess';

const wiki: BrainWiki = {
  wikiId: 'w 1',
  wikiName: 'Docs',
  type: 'codeWiki',
  repositoryId: 'r',
  gitUrl: 'https://dev.azure.com/org/Acme/_git/code',
  version: 'main',
  mappedPath: '/docs',
  rootPath: '/Customers',
};

describe('wikiPageUrl', () => {
  it('strips the mapped path and .md and decodes page names', () => {
    expect(
      wikiPageUrl(
        'https://dev.azure.com/org/',
        'Acme NV',
        wiki,
        '/docs/Customers/Kick%2Doff-notes.md',
      ),
    ).toBe(
      'https://dev.azure.com/org/Acme%20NV/_wiki/wikis/w%201?pagePath=%2FCustomers%2FKick-off%20notes',
    );
  });
});

describe('rootGitItemPath', () => {
  it("is '' for the wiki root and the page's file otherwise", async () => {
    const pages = async () => [
      { path: '/Customers', gitItemPath: '/Customers.md', isParent: true },
    ];
    expect(await rootGitItemPath({ ...wiki, rootPath: '/' }, pages)).toEqual({
      ok: true,
      path: '',
    });
    expect(await rootGitItemPath(wiki, pages)).toEqual({
      ok: true,
      path: '/Customers.md',
    });
  });
});

describe('mirrorAuthFor', () => {
  it('scopes the PAT header to the organization, and sends none to other hosts', async () => {
    const auth = mirrorAuthFor(async () => 'pat');
    const env = await auth('c1', wiki.gitUrl)();
    expect(Object.values(env)).toContain(
      'http.https://dev.azure.com/org/.extraHeader',
    );
    expect(await auth('c1', '/local/repo')()).toEqual({});
  });
});

describe('brain telemetry', () => {
  it('buckets sizes and page counts', () => {
    expect([0, 20_000, 200_000, 2_000_000].map(sizeBucket)).toEqual([
      '<10',
      '10-100',
      '100-1000',
      '>1000',
    ]);
    expect([0, 10, 11, 101].map(pagesBucket)).toEqual([
      '0',
      '1-10',
      '11-100',
      '>100',
    ]);
  });

  it('reports each finished job once', () => {
    const events: unknown[] = [];
    const observe = jobTelemetry((n, p) => events.push([n, p]));
    const job = {
      id: 'j',
      kind: 'capture',
      status: 'running',
      startedAt: '2026-11-03T09:00:00.000Z',
      endedAt: null,
    } as BrainJob;
    observe([job]);
    const done = {
      ...job,
      status: 'done',
      endedAt: '2026-11-03T09:00:02.000Z',
    } as BrainJob;
    observe([done]);
    observe([done]);
    expect(events).toEqual([
      ['brain.job', { kind: 'capture', outcome: 'ok', ms: 2000 }],
    ]);
  });
});
