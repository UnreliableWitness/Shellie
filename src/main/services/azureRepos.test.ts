import { describe, expect, it } from 'vitest';
import type { Connection } from '../../shared/types';
import {
  matchConnection,
  organizationOf,
  parseAzureReposRemote,
  prAvailability,
  prDescription,
  prTitle,
  prWebUrl,
  targetBranch,
} from './azureRepos';

describe('parseAzureReposRemote', () => {
  const ref = { org: 'contoso', project: 'Web Shop', repo: 'DXP' };
  it.each([
    'https://dev.azure.com/contoso/Web%20Shop/_git/DXP',
    'https://contoso@dev.azure.com/contoso/Web%20Shop/_git/DXP',
    'https://dev.azure.com/contoso/Web%20Shop/_git/DXP.git',
    'https://dev.azure.com/contoso/Web%20Shop/_git/DXP/',
    'https://contoso.visualstudio.com/Web%20Shop/_git/DXP',
    'https://contoso.visualstudio.com/DefaultCollection/Web%20Shop/_git/DXP',
    'git@ssh.dev.azure.com:v3/contoso/Web%20Shop/DXP',
    'ssh://git@ssh.dev.azure.com/v3/contoso/Web%20Shop/DXP',
    'contoso@vs-ssh.visualstudio.com:v3/contoso/Web%20Shop/DXP',
  ])('parses %s', (url) => {
    expect(parseAzureReposRemote(url)).toEqual(ref);
  });
  it.each([
    'https://github.com/contoso/dxp.git',
    'git@github.com:contoso/dxp.git',
    '/Users/me/origin.git',
    '',
    'https://dev.azure.com/contoso/_git',
  ])('rejects %s', (url) => {
    expect(parseAzureReposRemote(url)).toBeNull();
  });
});

describe('organizationOf', () => {
  it('reads both URL styles, lower-cased', () => {
    expect(organizationOf('https://dev.azure.com/Contoso')).toBe('contoso');
    expect(organizationOf('https://dev.azure.com/contoso/')).toBe('contoso');
    expect(organizationOf('https://Contoso.visualstudio.com')).toBe('contoso');
    expect(organizationOf('not a url')).toBeNull();
  });
});

describe('prAvailability', () => {
  const remote = 'https://dev.azure.com/contoso/P/_git/R';
  it('is available for a remote in the connection org', () => {
    expect(
      prAvailability({
        remoteUrl: remote,
        connectionOrgUrl: 'https://dev.azure.com/Contoso',
      }),
    ).toEqual({
      available: true,
      reason: null,
      target: { org: 'contoso', project: 'P', repo: 'R' },
    });
  });
  it('explains why not', () => {
    expect(
      prAvailability({ remoteUrl: remote, connectionOrgUrl: null }).reason,
    ).toBe('this repo has no Azure DevOps connection');
    expect(
      prAvailability({
        remoteUrl: 'https://github.com/a/b',
        connectionOrgUrl: 'https://dev.azure.com/contoso',
      }).reason,
    ).toBe('origin is not an Azure Repos URL');
    expect(
      prAvailability({
        remoteUrl: null,
        connectionOrgUrl: 'https://dev.azure.com/contoso',
      }).reason,
    ).toBe('origin is not an Azure Repos URL');
    expect(
      prAvailability({
        remoteUrl: remote,
        connectionOrgUrl: 'https://dev.azure.com/fabrikam',
      }).reason,
    ).toBe('origin is in another Azure DevOps organization');
  });
});

describe('targetBranch', () => {
  it('strips a known remote prefix only', () => {
    expect(targetBranch('origin/main', ['origin'])).toBe('main');
    expect(targetBranch('upstream/dev', ['origin', 'upstream'])).toBe('dev');
    expect(targetBranch('main', ['origin'])).toBe('main');
    expect(targetBranch('feature/x', ['origin'])).toBe('feature/x');
  });
});

describe('prTitle', () => {
  it('uses id and title, or the task name', () => {
    expect(prTitle({ workItem: { id: '42', title: 'Fix it' }, name: '' })).toBe(
      '42 Fix it',
    );
    expect(prTitle({ workItem: null, name: 'Spike' })).toBe('Spike');
  });
});

describe('prWebUrl', () => {
  it('encodes project and repo', () => {
    expect(
      prWebUrl('https://dev.azure.com/contoso/', 'Web Shop', 'DXP', 7),
    ).toBe('https://dev.azure.com/contoso/Web%20Shop/_git/DXP/pullrequest/7');
  });
});

describe('prDescription', () => {
  const base = {
    heading: 'Bug 42: Fix it',
    commits: [
      { sha: 'abc1234', subject: 'First' },
      { sha: 'def5678', subject: 'Second' },
    ],
    commitCount: 2,
  };
  it('lists the commits', () => {
    expect(prDescription(base)).toBe(
      'Bug 42: Fix it\n\n## Commits\n- abc1234 First\n- def5678 Second\n\nRecorded by Shellie',
    );
  });
  it('says which environment the task ran against, unless Development', () => {
    expect(prDescription({ ...base, environment: 'uat' })).toBe(
      'Bug 42: Fix it\n\nRun against UAT\n\n## Commits\n- abc1234 First\n- def5678 Second\n\nRecorded by Shellie',
    );
    expect(
      prDescription({ ...base, environment: 'production', commits: [] }),
    ).toContain('Run against Production');
    expect(
      prDescription({ ...base, environment: 'development' }),
    ).not.toContain('Run against');
  });
  it('never puts AI cost in the PR description', () => {
    const text = prDescription(base);
    expect(text).not.toContain('\u20ac');
    expect(text).not.toContain('AI cost');
    expect(text).not.toContain('recorded by Shellie');
  });
  it('names the work item URL when the PR cannot link it', () => {
    expect(
      prDescription({
        ...base,
        workItemUrl: 'https://dev.azure.com/o/P/_workitems/edit/42',
      }),
    ).toMatch(
      /^Bug 42: Fix it\n\nWork item: https:\/\/dev\.azure\.com\/o\/P\/_workitems\/edit\/42\n\n## Commits/,
    );
  });
  it('mentions commits beyond the list', () => {
    expect(prDescription({ ...base, commitCount: 5 })).toContain(
      '…and 3 more commits',
    );
  });
  it('stays within 4000 characters by dropping commits', () => {
    const commits = Array.from({ length: 300 }, (_, i) => ({
      sha: `s${String(i).padStart(6, '0')}`,
      subject: 'x'.repeat(40),
    }));
    const text = prDescription({ ...base, commits, commitCount: 300 });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toMatch(/…and \d+ more commits/);
    expect(text.endsWith('\n\nRecorded by Shellie')).toBe(true);
  });
  it('puts the written summary between the heading and the commits', () => {
    expect(
      prDescription({
        ...base,
        summary: '## What changed\nThe fix.\n\n## Why\nIt was broken.\n',
      }),
    ).toBe(
      'Bug 42: Fix it\n\n## What changed\nThe fix.\n\n## Why\nIt was broken.\n\n## Commits\n- abc1234 First\n- def5678 Second\n\nRecorded by Shellie',
    );
  });
  it('ignores a blank summary', () => {
    expect(prDescription({ ...base, summary: '  \n' })).toBe(
      prDescription(base),
    );
  });
  it('drops commits before cutting the summary, then cuts the summary', () => {
    const commits = Array.from({ length: 300 }, (_, i) => ({
      sha: `s${String(i).padStart(6, '0')}`,
      subject: 'x'.repeat(40),
    }));
    const summary = 'y'.repeat(2500);
    const text = prDescription({
      ...base,
      commits,
      commitCount: 300,
      summary,
    });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain(summary);
    expect(text).toMatch(/…and \d+ more commits/);
    const huge = prDescription({ ...base, summary: 'z'.repeat(5000) });
    expect(huge.length).toBeLessThanOrEqual(4000);
    expect(huge.startsWith('Bug 42: Fix it\n\nzzz')).toBe(true);
    expect(huge).toContain('…');
    expect(huge.endsWith('\n\nRecorded by Shellie')).toBe(true);
  });
  it('omits the commits section when there are none', () => {
    expect(prDescription({ ...base, commits: [], commitCount: 0 })).toBe(
      'Bug 42: Fix it\n\nRecorded by Shellie',
    );
  });
});

describe('matchConnection', () => {
  const conn = (
    id: string,
    organizationUrl: string,
    project: string,
  ): Connection => ({
    id,
    name: id,
    organizationUrl,
    project,
    user: null,
    status: 'ok',
    checkedAt: null,
    userUniqueName: null,
    provider: 'azure-devops' as const,
    workItemOnStart: {
      moveToInProgress: true,
      assignToMe: true,
      stateOverrides: {},
    },
    writeTimeToAdo: false,
  });
  const other = conn('other', 'https://dev.azure.com/fabrikam', 'Web');
  const sameOrg = conn('org', 'https://dev.azure.com/contoso', 'Intranet');
  const sameProject = conn(
    'proj',
    'https://contoso.visualstudio.com',
    'Web Shop',
  );

  it('matches the connection with the same organization', () => {
    expect(
      matchConnection('https://dev.azure.com/contoso/Web%20Shop/_git/DXP', [
        other,
        sameOrg,
      ])?.id,
    ).toBe('org');
  });

  it('prefers the connection with the same project', () => {
    expect(
      matchConnection('https://dev.azure.com/contoso/Web%20Shop/_git/DXP', [
        sameOrg,
        sameProject,
      ])?.id,
    ).toBe('proj');
  });

  it('returns null for GitHub, no remote and no matching organization', () => {
    expect(
      matchConnection('https://github.com/contoso/dxp.git', [sameOrg]),
    ).toBeNull();
    expect(matchConnection(null, [sameOrg])).toBeNull();
    expect(
      matchConnection('https://dev.azure.com/northwind/P/_git/R', [
        other,
        sameOrg,
      ]),
    ).toBeNull();
  });
});
