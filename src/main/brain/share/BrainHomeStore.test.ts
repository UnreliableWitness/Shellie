import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeCrypto } from '../../test-helpers/fakeCrypto';
import { BrainHomeStore, type VerifyHome } from './BrainHomeStore';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'shellie-home-'));
  dirs.push(d);
  return path.join(d, 'brain-home.json');
};
const ok: VerifyHome = async (_o, _p, project) => ({ user: 'Ann', project });

describe('BrainHomeStore', () => {
  it('saves a home, hands it out without the token, and decrypts the token', async () => {
    const f = file();
    const s = new BrainHomeStore(f, fakeCrypto(), ok);
    await s.load();
    expect(s.get()).toBeNull();
    const saved = await s.save({
      organizationUrl: 'dev.azure.com/Acme/',
      project: ' Brains ',
      pat: ' secret-pat ',
    });
    expect(saved).toEqual({
      organizationUrl: 'https://dev.azure.com/Acme',
      project: 'Brains',
      user: 'Ann',
    });
    expect(JSON.stringify(s.get())).not.toContain('secret-pat');
    expect(await s.token()).toBe('secret-pat');
    expect(readFileSync(f, 'utf8')).not.toContain('secret-pat');
    const again = new BrainHomeStore(f, fakeCrypto(), ok);
    await again.load();
    expect(again.get()).toEqual(saved);
    expect(await again.token()).toBe('secret-pat');
  });

  it('rejects a bad URL and saves nothing', async () => {
    const s = new BrainHomeStore(file(), fakeCrypto(), ok);
    await s.load();
    await expect(
      s.save({
        organizationUrl: 'https://example.com/x',
        project: 'P',
        pat: 'x',
      }),
    ).rejects.toThrow();
    expect(s.get()).toBeNull();
  });

  it('rejects an unknown project or a bad token and keeps the old home', async () => {
    const f = file();
    const s = new BrainHomeStore(f, fakeCrypto(), ok);
    await s.load();
    await s.save({
      organizationUrl: 'https://dev.azure.com/Acme',
      project: 'Brains',
      pat: 'good',
    });
    const bad = new BrainHomeStore(f, fakeCrypto(), async () => {
      throw new Error('The project "Nope" is not in that organization');
    });
    await bad.load();
    await expect(
      bad.save({
        organizationUrl: 'https://dev.azure.com/Acme',
        project: 'Nope',
        pat: 'x',
      }),
    ).rejects.toThrow('not in that organization');
    expect(bad.get()?.project).toBe('Brains');
    expect(await bad.token()).toBe('good');
  });

  it('does not save when encryption is unavailable', async () => {
    const s = new BrainHomeStore(file(), fakeCrypto(false), ok);
    await s.load();
    await expect(
      s.save({
        organizationUrl: 'https://dev.azure.com/Acme',
        project: 'P',
        pat: 'x',
      }),
    ).rejects.toThrow('encryption');
    expect(s.get()).toBeNull();
  });

  it('removes the home and its token', async () => {
    const s = new BrainHomeStore(file(), fakeCrypto(), ok);
    await s.load();
    await s.save({
      organizationUrl: 'https://dev.azure.com/Acme',
      project: 'P',
      pat: 'x',
    });
    await s.remove();
    expect(s.get()).toBeNull();
    await expect(s.token()).rejects.toThrow();
  });
});
