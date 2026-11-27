import { describe, expect, it } from 'vitest';
import { BrainSchema } from './brain';
import {
  isJoinLink,
  isKeeper,
  joinLink,
  parseJoinLink,
  parseRepoJoin,
  parseRepoUrl,
  repoHomeOf,
  repoJoinLink,
} from './brainShare';

describe('join link', () => {
  it('round-trips an organization url with spaces and ampersands', () => {
    const o = {
      organizationUrl: 'https://dev.azure.com/my org&co',
      project: 'A & B project',
      repositoryId: 'abc-123',
    };
    const link = joinLink(o);
    expect(link.startsWith('shellie://join?')).toBe(true);
    expect(parseJoinLink(link)).toEqual(o);
  });
  it('rejects anything else', () => {
    expect(parseJoinLink('https://x')).toBeNull();
    expect(parseJoinLink('shellie://join?org=http://evil')).toBeNull();
    expect(
      parseJoinLink('shellie://join?org=http%3A%2F%2Fevil&project=p&repo=r'),
    ).toBeNull();
    expect(parseJoinLink('not a url')).toBeNull();
  });
  it('accepts only an Azure DevOps organization', () => {
    const link = (organizationUrl: string) =>
      parseJoinLink(
        joinLink({ organizationUrl, project: 'p', repositoryId: 'r' }),
      );
    expect(link('https://evil.example/x')).toBeNull();
    expect(link('https://dev.azure.com.evil.example/x')).toBeNull();
    expect(link('https://dev.azure.com/')).toBeNull();
    expect(link('https://user:pw@dev.azure.com/x')).toBeNull();
    expect(link('https://dev.azure.com/contoso')).not.toBeNull();
    expect(link('https://contoso.visualstudio.com')).not.toBeNull();
  });
});

describe('BrainSchema.sharing', () => {
  it('is null on an old brain', () => {
    const b = BrainSchema.parse({
      id: 'b',
      name: 'B',
      connectionId: 'c',
      project: 'p',
      path: '/x',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(b.sharing).toBeNull();
  });
});

describe('isKeeper', () => {
  it('compares the keeper install id', () => {
    const origin = {
      format: 1 as const,
      organizationUrl: 'https://dev.azure.com/o',
      project: 'p',
      name: 'n',
      keeper: { installId: 'a', name: 'A' },
      sharedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(isKeeper(origin, 'a')).toBe(true);
    expect(isKeeper(origin, 'b')).toBe(false);
  });
});

describe('a repo address', () => {
  it('reads https, ssh and scp-style addresses', () => {
    expect(parseRepoUrl(' https://github.com/acme/project-brain.git ')).toEqual(
      {
        remoteUrl: 'https://github.com/acme/project-brain.git',
        host: 'github.com',
        owner: 'acme',
        name: 'project-brain',
      },
    );
    expect(parseRepoUrl('git@github.com:acme/brain.git')).toMatchObject({
      host: 'github.com',
      owner: 'acme',
      name: 'brain',
    });
    expect(parseRepoUrl('ssh://git@gitlab.com/a/b/brain')).toMatchObject({
      host: 'gitlab.com',
      owner: 'a/b',
      name: 'brain',
    });
    expect(repoHomeOf(parseRepoUrl('https://github.com/acme/brain')!)).toEqual({
      organizationUrl: 'https://github.com/acme',
      project: 'brain',
    });
  });

  it('refuses anything else', () => {
    for (const bad of [
      '',
      'acme/brain',
      'http://github.com/acme/brain',
      'https://user:secret@github.com/acme/brain',
      'https://token@github.com/acme/brain',
      'https://github.com/acme',
      'https://github.com/acme/brain?x=1',
      '--upload-pack=evil',
      'ext::sh -c evil',
      'file:///tmp/repo',
      '/tmp/repo',
      'https://github.com/acme/brain and more',
    ])
      expect(parseRepoUrl(bad), bad).toBeNull();
  });

  it('round-trips through a join link, and is a join link only in its shellie form', () => {
    const url = 'https://github.com/acme/project-brain.git';
    const link = repoJoinLink(url);
    expect(parseRepoJoin(link)?.remoteUrl).toBe(url);
    expect(parseRepoJoin(url)?.remoteUrl).toBe(url);
    expect(parseRepoJoin('shellie://join?url=file%3A%2F%2F%2Ftmp')).toBeNull();
    expect(parseRepoJoin('shellie://other?url=x')).toBeNull();
    expect(isJoinLink(link)).toBe(true);
    expect(isJoinLink(url)).toBe(false);
    expect(parseJoinLink(link)).toBeNull();
    expect(
      isJoinLink(
        joinLink({
          organizationUrl: 'https://dev.azure.com/o',
          project: 'p',
          repositoryId: 'r',
        }),
      ),
    ).toBe(true);
  });
});
