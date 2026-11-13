import { describe, expect, it } from 'vitest';
import { BrainSchema } from './brain';
import { isKeeper, joinLink, parseJoinLink } from './brainShare';

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
