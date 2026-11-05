import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConnectionStore,
  normalizeOrganizationUrl,
  organizationSlug,
} from './ConnectionStore';
import { fakeCrypto } from '../test-helpers/fakeCrypto';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'shellie-conn-'));
  dirs.push(d);
  return path.join(d, 'connections.json');
};

describe('loopback seam', () => {
  it('accepts loopback http only when allowed', () => {
    expect(() =>
      normalizeOrganizationUrl('http://127.0.0.1:5555/org'),
    ).toThrow();
    expect(
      normalizeOrganizationUrl('http://127.0.0.1:5555/org', {
        allowLoopbackHttp: true,
      }),
    ).toBe('http://127.0.0.1:5555/org');
  });
  it('a strict store rejects localhost', () => {
    const store = new ConnectionStore(file(), fakeCrypto());
    expect(() => store.normalizeUrl('http://localhost:5555/org')).toThrow();
  });
});

describe('normalizeOrganizationUrl', () => {
  it('accepts dev.azure.com org URLs with extra path or slash', () => {
    expect(
      normalizeOrganizationUrl('https://dev.azure.com/unreliablewitness/'),
    ).toBe('https://dev.azure.com/unreliablewitness');
    expect(
      normalizeOrganizationUrl(
        'https://dev.azure.com/unreliablewitness/Shellie/_workitems',
      ),
    ).toBe('https://dev.azure.com/unreliablewitness');
    expect(normalizeOrganizationUrl('  dev.azure.com/Contoso ')).toBe(
      'https://dev.azure.com/Contoso',
    );
  });
  it('accepts visualstudio.com org URLs', () => {
    expect(
      normalizeOrganizationUrl('https://contoso.visualstudio.com/Project'),
    ).toBe('https://contoso.visualstudio.com');
  });
  it('rejects other hosts and a missing org', () => {
    expect(() => normalizeOrganizationUrl('https://github.com/x')).toThrow(
      /dev\.azure\.com/,
    );
    expect(() => normalizeOrganizationUrl('https://dev.azure.com/')).toThrow(
      /organization/,
    );
  });
  it('derives the slug', () => {
    expect(organizationSlug('https://dev.azure.com/unreliablewitness')).toBe(
      'unreliablewitness',
    );
    expect(organizationSlug('https://contoso.visualstudio.com')).toBe(
      'contoso',
    );
  });
});

describe('ConnectionStore', () => {
  it('saves a connection with an encrypted token and lists it without the token', async () => {
    const f = file();
    const store = new ConnectionStore(f, fakeCrypto());
    await store.load();
    const c = await store.save({
      organizationUrl: 'https://dev.azure.com/unreliablewitness/',
      project: 'Shellie',
      pat: 'secret-pat',
    });
    expect(c).toMatchObject({
      name: 'unreliablewitness',
      organizationUrl: 'https://dev.azure.com/unreliablewitness',
      project: 'Shellie',
      user: null,
      status: 'unknown',
      checkedAt: null,
      userUniqueName: null,
    });
    expect(store.list()).toEqual([c]);
    expect(JSON.stringify(store.list())).not.toContain('secret-pat');
    expect(readFileSync(f, 'utf8')).not.toContain('secret-pat');
    expect(await store.token(c.id)).toBe('secret-pat');
  });

  it('patch changes workItemOnStart and writeTimeToAdo and keeps the token and status', async () => {
    const store = new ConnectionStore(file(), fakeCrypto());
    await store.load();
    const c = await store.save({
      organizationUrl: 'https://dev.azure.com/unreliablewitness/',
      project: 'Shellie',
      pat: 'secret-pat',
    });
    await store.setStatus(c.id, 'ok', 'Dries', 'd@x.com');
    const patched = await store.patch(c.id, {
      writeTimeToAdo: true,
      workItemOnStart: {
        moveToInProgress: true,
        assignToMe: false,
        stateOverrides: {},
      },
    });
    expect(patched).toMatchObject({
      writeTimeToAdo: true,
      status: 'ok',
      user: 'Dries',
    });
    expect(patched.workItemOnStart.assignToMe).toBe(false);
    expect(store.get(c.id).status).toBe('ok');
    expect(await store.token(c.id)).toBe('secret-pat');
    await expect(store.patch('ghost', {})).rejects.toThrow(
      /Unknown connection/,
    );
  });
  it('reloads from disk and still decrypts', async () => {
    const f = file();
    const a = new ConnectionStore(f, fakeCrypto());
    await a.load();
    const c = await a.save({
      organizationUrl: 'https://dev.azure.com/o',
      project: 'P',
      pat: 'tok',
    });
    const b = new ConnectionStore(f, fakeCrypto());
    await b.load();
    expect(b.list()).toEqual([c]);
    expect(await b.token(c.id)).toBe('tok');
  });

  it('setStatus stores userUniqueName', async () => {
    const store = new ConnectionStore(file(), fakeCrypto());
    await store.load();
    const c = await store.save({
      organizationUrl: 'https://dev.azure.com/o',
      project: 'P',
      pat: 'tok',
    });
    expect(c.userUniqueName).toBeNull();
    const updated = await store.setStatus(c.id, 'ok', 'Dries', 'd@x.com');
    expect(updated.userUniqueName).toBe('d@x.com');
  });

  it('loads an old file without userUniqueName as null', async () => {
    const f = file();
    writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        connections: [
          {
            id: 'c1',
            name: 'o',
            organizationUrl: 'https://dev.azure.com/o',
            project: 'P',
            user: 'Dries',
            status: 'ok',
            checkedAt: null,
            tokenCiphertext: 'x',
          },
        ],
      }),
    );
    const store = new ConnectionStore(f, fakeCrypto());
    await store.load();
    expect(store.get('c1').userUniqueName).toBeNull();
  });

  it('reads a connections file saved before providers existed as Azure DevOps', async () => {
    const f = file();
    writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        connections: [
          {
            id: 'c1',
            name: 'o',
            organizationUrl: 'https://dev.azure.com/o',
            project: 'P',
            user: 'Dries',
            status: 'ok',
            checkedAt: null,
            tokenCiphertext: 'x',
          },
        ],
      }),
    );
    const store = new ConnectionStore(f, fakeCrypto());
    await store.load();
    expect(store.list()[0].provider).toBe('azure-devops');
  });

  it('keeps the provider it saved', async () => {
    const f = file();
    const store = new ConnectionStore(f, fakeCrypto());
    await store.load();
    await store.save({
      organizationUrl: 'https://dev.azure.com/o',
      project: 'P',
      pat: 'tok',
      provider: 'github',
    });
    const again = new ConnectionStore(f, fakeCrypto());
    await again.load();
    expect(again.list()[0].provider).toBe('github');
  });

  it('stores the on-start options it was given, keeps them on a re-save without, and defaults old files', async () => {
    const f = file();
    const store = new ConnectionStore(f, fakeCrypto());
    await store.load();
    const options = {
      moveToInProgress: false,
      assignToMe: true,
      stateOverrides: {},
    };
    const c = await store.save({
      organizationUrl: 'https://dev.azure.com/o',
      project: 'P',
      pat: 'tok',
      workItemOnStart: options,
    });
    expect(c.workItemOnStart).toEqual(options);
    await store.save({
      id: c.id,
      organizationUrl: 'https://dev.azure.com/o',
      project: 'P',
      pat: 'tok2',
    });
    const again = new ConnectionStore(f, fakeCrypto());
    await again.load();
    expect(again.get(c.id).workItemOnStart).toEqual(options);
    expect(c.writeTimeToAdo).toBe(false);
    expect(again.list()[0].writeTimeToAdo).toBe(false);
    writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        connections: [
          {
            id: 'c1',
            name: 'o',
            organizationUrl: 'https://dev.azure.com/o',
            project: 'P',
            user: null,
            status: 'ok',
            checkedAt: null,
            tokenCiphertext: 'x',
          },
        ],
      }),
    );
    const old = new ConnectionStore(f, fakeCrypto());
    await old.load();
    expect(old.get('c1').workItemOnStart).toEqual({
      moveToInProgress: true,
      assignToMe: true,
      stateOverrides: {},
    });
  });

  it('updates an existing connection by id and resets its status', async () => {
    const store = new ConnectionStore(file(), fakeCrypto());
    await store.load();
    const c = await store.save({
      organizationUrl: 'https://dev.azure.com/o',
      project: 'P',
      pat: 'tok',
    });
    await store.setStatus(c.id, 'ok', 'Dries');
    const updated = await store.save({
      id: c.id,
      name: 'Client',
      organizationUrl: 'https://dev.azure.com/o',
      project: 'Q',
      pat: 'tok2',
    });
    expect(updated).toMatchObject({
      id: c.id,
      name: 'Client',
      project: 'Q',
      status: 'unknown',
      user: null,
    });
    expect(store.list()).toHaveLength(1);
    expect(await store.token(c.id)).toBe('tok2');
  });

  it('refuses to save when encryption is unavailable', async () => {
    const store = new ConnectionStore(file(), fakeCrypto(false));
    await store.load();
    await expect(
      store.save({
        organizationUrl: 'https://dev.azure.com/o',
        project: 'P',
        pat: 'tok',
      }),
    ).rejects.toThrow(/encryption/i);
    expect(store.list()).toEqual([]);
  });

  it('rejects an empty pat or project', async () => {
    const store = new ConnectionStore(file(), fakeCrypto());
    await store.load();
    await expect(
      store.save({
        organizationUrl: 'https://dev.azure.com/o',
        project: '',
        pat: 'tok',
      }),
    ).rejects.toThrow(/project/i);
    await expect(
      store.save({
        organizationUrl: 'https://dev.azure.com/o',
        project: 'P',
        pat: '  ',
      }),
    ).rejects.toThrow(/token/i);
  });

  it('removes and reports unknown ids', async () => {
    const store = new ConnectionStore(file(), fakeCrypto());
    await store.load();
    const c = await store.save({
      organizationUrl: 'https://dev.azure.com/o',
      project: 'P',
      pat: 'tok',
    });
    await store.remove(c.id);
    expect(store.list()).toEqual([]);
    expect(() => store.get(c.id)).toThrow(/Unknown connection/);
    await expect(store.token(c.id)).rejects.toThrow(/Unknown connection/);
  });

  it('turns a decrypt failure into a readable error', async () => {
    const f = file();
    const store = new ConnectionStore(f, fakeCrypto());
    await store.load();
    const c = await store.save({
      organizationUrl: 'https://dev.azure.com/o',
      project: 'P',
      pat: 'tok',
    });
    const broken = new ConnectionStore(f, {
      ...fakeCrypto(),
      decrypt: () => {
        throw new Error('bad key');
      },
    });
    await broken.load();
    await expect(broken.token(c.id)).rejects.toThrow(/could not be decrypted/);
  });

  it('keeps a stored record with an invalid organization URL but never serves its token', async () => {
    const f = file();
    const lax = new ConnectionStore(f, fakeCrypto(), {
      allowLoopbackHttp: true,
    });
    await lax.load();
    const c = await lax.save({
      organizationUrl: 'http://localhost:1/org',
      project: 'P',
      pat: 'tok',
    });
    await lax.setStatus(c.id, 'ok', 'Someone');
    const strict = new ConnectionStore(f, fakeCrypto());
    await strict.load();
    expect(strict.list().map((x) => [x.id, x.status])).toEqual([
      [c.id, 'unauthorized'],
    ]);
    await expect(strict.token(c.id)).rejects.toThrow(
      'This connection has an invalid organization URL; remove it and add it again',
    );
  });

  it('backs up a corrupt file and starts empty', async () => {
    const f = file();
    writeFileSync(f, '{ nope');
    const store = new ConnectionStore(f, fakeCrypto());
    const r = await store.load();
    expect(r.recovered).toBe(true);
    expect(store.list()).toEqual([]);
  });
});
