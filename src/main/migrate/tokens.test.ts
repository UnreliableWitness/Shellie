import {
  createCipheriv,
  pbkdf2Sync,
  randomBytes,
  type CipherGCM,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConnectionsFileSchema,
  type ConnectionsFile,
} from '../../shared/types';
import {
  DPAPI_TIMEOUT_MS,
  KEYCHAIN_TIMEOUT_MS,
  type RunFile,
  decryptChromiumMac,
  decryptChromiumWin,
  migrateTokens,
  parseLocalStateKey,
  readMiacKeychainPassword,
  readMiacWindowsKey,
  runFile,
} from './tokens';

// Chromium's macOS os_crypt: "v10" + AES-128-CBC, key PBKDF2-SHA1(password, "saltysalt", 1003, 16), IV 16 spaces.
function chromiumEncrypt(plain: string, password: string): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([
    Buffer.from('v10'),
    c.update(plain, 'utf8'),
    c.final(),
  ]);
}

// Chromium's Windows os_crypt: "v10" + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag.
function chromiumEncryptWin(plain: string, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce) as CipherGCM;
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from('v10'), nonce, ct, c.getAuthTag()]);
}

type Stored = ConnectionsFile['connections'][number];

const conn = (id: string, cipher: Buffer): Stored => ({
  id,
  name: 'o',
  organizationUrl: 'https://dev.azure.com/o',
  project: 'P',
  user: 'Dries',
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
  tokenCiphertext: cipher.toString('base64'),
});

function writeConnections(connections: Stored[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-tokens-'));
  const file = path.join(dir, 'connections.json');
  writeFileSync(file, JSON.stringify({ version: 1, connections }, null, 2));
  return file;
}

const read = (file: string): ConnectionsFile =>
  ConnectionsFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));

const tokens = (file: string) =>
  read(file).connections.map((c) =>
    Buffer.from(c.tokenCiphertext, 'base64').toString(),
  );

const mac = (password: string) => async () =>
  ({ kind: 'mac', password }) as const;

const newKey = (p: string) => Buffer.from(`new:${p}`);

describe('decryptChromiumMac', () => {
  it('decrypts what Chromium encrypted', () => {
    expect(decryptChromiumMac(chromiumEncrypt('pat-123', 'pw'), 'pw')).toBe(
      'pat-123',
    );
  });

  it('throws without the v10 prefix', () => {
    expect(() => decryptChromiumMac(Buffer.from('xyzabc'), 'pw')).toThrow();
  });
});

describe('decryptChromiumWin', () => {
  it('decrypts what Chromium encrypted', () => {
    const key = randomBytes(32);
    expect(decryptChromiumWin(chromiumEncryptWin('pat-123', key), key)).toBe(
      'pat-123',
    );
  });

  it('throws on a tampered tag', () => {
    const key = randomBytes(32);
    const c = chromiumEncryptWin('pat-123', key);
    c[c.length - 1] ^= 0xff;
    expect(() => decryptChromiumWin(c, key)).toThrow();
  });

  it('throws without the v10 prefix', () => {
    const key = randomBytes(32);
    const c = chromiumEncryptWin('pat-123', key);
    c[0] = 0x78;
    expect(() => decryptChromiumWin(c, key)).toThrow();
  });
});

describe('migrateTokens', () => {
  it('re-encrypts every token with the new key', async () => {
    const file = writeConnections([
      conn('a', chromiumEncrypt('pat-a', 'pw')),
      conn('b', chromiumEncrypt('pat-b', 'pw')),
    ]);
    const r = await migrateTokens({
      file,
      readOldKey: mac('pw'),
      encrypt: newKey,
    });
    expect(r).toBe('migrated');
    expect(tokens(file)).toEqual(['new:pat-a', 'new:pat-b']);
    expect(read(file).connections.map((c) => c.status)).toEqual(['ok', 'ok']);
  });

  it('re-encrypts every token with a Windows key', async () => {
    const key = randomBytes(32);
    const file = writeConnections([
      conn('a', chromiumEncryptWin('pat-a', key)),
      conn('b', chromiumEncryptWin('pat-b', key)),
    ]);
    const r = await migrateTokens({
      file,
      readOldKey: async () => ({ kind: 'win', key }),
      encrypt: newKey,
    });
    expect(r).toBe('migrated');
    expect(tokens(file)).toEqual(['new:pat-a', 'new:pat-b']);
  });

  it('marks a token that does not decrypt as unauthorized and keeps the others', async () => {
    const file = writeConnections([
      conn('a', chromiumEncrypt('pat-a', 'pw')),
      conn('b', Buffer.from('v10garbage-garbage')),
    ]);
    expect(
      await migrateTokens({ file, readOldKey: mac('pw'), encrypt: newKey }),
    ).toBe('partial');
    const [a, b] = read(file).connections;
    expect(Buffer.from(a.tokenCiphertext, 'base64').toString()).toBe(
      'new:pat-a',
    );
    expect(a.status).toBe('ok');
    expect(b.status).toBe('unauthorized');
  });

  it('keeps every connection, unauthorized, when the Keychain prompt is refused', async () => {
    const file = writeConnections([conn('a', chromiumEncrypt('pat-a', 'pw'))]);
    expect(
      await migrateTokens({
        file,
        readOldKey: async () => {
          throw new Error('User canceled');
        },
        encrypt: () => Buffer.alloc(0),
      }),
    ).toBe('refused');
    expect(read(file).connections).toHaveLength(1);
    expect(read(file).connections[0].status).toBe('unauthorized');
  });

  it('does nothing for an empty connections file', async () => {
    const file = writeConnections([]);
    const before = readFileSync(file, 'utf8');
    expect(
      await migrateTokens({
        file,
        readOldKey: mac('pw'),
        encrypt: () => Buffer.alloc(0),
      }),
    ).toBe('none');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('writes the file the way ConnectionStore does', async () => {
    const file = writeConnections([conn('a', chromiumEncrypt('pat-a', 'pw'))]);
    await migrateTokens({ file, readOldKey: mac('pw'), encrypt: newKey });
    const raw = readFileSync(file, 'utf8');
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2));
  });
});

describe('parseLocalStateKey', () => {
  it('returns the DPAPI blob after the prefix', () => {
    const blob = Buffer.from('made-up-blob');
    const json = JSON.stringify({
      os_crypt: {
        encrypted_key: Buffer.concat([Buffer.from('DPAPI'), blob]).toString(
          'base64',
        ),
      },
    });
    expect(parseLocalStateKey(json)).toEqual(blob);
  });

  it('throws when the key is missing', () => {
    expect(() => parseLocalStateKey('{}')).toThrow();
    expect(() => parseLocalStateKey('{"os_crypt":{}}')).toThrow();
  });

  it('throws on a wrong prefix', () => {
    const json = JSON.stringify({
      os_crypt: { encrypted_key: Buffer.from('XXXXXblob').toString('base64') },
    });
    expect(() => parseLocalStateKey(json)).toThrow();
  });
});

describe('readMiacWindowsKey', () => {
  it.runIf(process.platform === 'win32')(
    'unprotects the key in Local State with DPAPI',
    async () => {
      const key = randomBytes(32);
      const blob = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:SHELLIE_TEST_KEY); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))",
        ],
        {
          env: { ...process.env, SHELLIE_TEST_KEY: key.toString('base64') },
          windowsHide: true,
        },
      )
        .toString()
        .trim();
      const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-ls-'));
      const localState = path.join(dir, 'Local State');
      writeFileSync(
        localState,
        JSON.stringify({
          os_crypt: {
            encrypted_key: Buffer.concat([
              Buffer.from('DPAPI'),
              Buffer.from(blob, 'base64'),
            ]).toString('base64'),
          },
        }),
      );
      const old = await readMiacWindowsKey(localState);
      expect(old.kind).toBe('win');
      expect(old.kind === 'win' && old.key.equals(key)).toBe(true);
    },
    30_000,
  );
});

describe('old key readers time out instead of blocking boot', () => {
  const timedOut =
    (seen: { file: string; timeout: number }[]): RunFile =>
    async (file, _args, opts) => {
      seen.push({ file, timeout: opts.timeout });
      throw Object.assign(new Error('spawn timed out'), {
        killed: true,
        signal: 'SIGTERM',
      });
    };

  it('runFile rejects when the command outlives its timeout', async () => {
    await expect(
      runFile(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
        timeout: 200,
      }),
    ).rejects.toThrow();
  });

  it('a Keychain prompt that times out means refused, connections unauthorized', async () => {
    const seen: { file: string; timeout: number }[] = [];
    const file = writeConnections([conn('a', chromiumEncrypt('pat-a', 'pw'))]);
    expect(
      await migrateTokens({
        file,
        readOldKey: () => readMiacKeychainPassword(timedOut(seen)),
        encrypt: newKey,
      }),
    ).toBe('refused');
    expect(seen).toEqual([{ file: 'security', timeout: KEYCHAIN_TIMEOUT_MS }]);
    expect(KEYCHAIN_TIMEOUT_MS).toBe(120_000);
    expect(read(file).connections[0].status).toBe('unauthorized');
  });

  it('a PowerShell that times out means refused, connections unauthorized', async () => {
    const seen: { file: string; timeout: number }[] = [];
    const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-ls-'));
    const localState = path.join(dir, 'Local State');
    writeFileSync(
      localState,
      JSON.stringify({
        os_crypt: {
          encrypted_key: Buffer.from('DPAPImade-up-blob').toString('base64'),
        },
      }),
    );
    const file = writeConnections([
      conn('a', chromiumEncryptWin('pat-a', randomBytes(32))),
    ]);
    expect(
      await migrateTokens({
        file,
        readOldKey: () => readMiacWindowsKey(localState, timedOut(seen)),
        encrypt: newKey,
      }),
    ).toBe('refused');
    expect(seen).toEqual([
      {
        file: path.join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        timeout: DPAPI_TIMEOUT_MS,
      },
    ]);
    expect(DPAPI_TIMEOUT_MS).toBe(30_000);
    expect(read(file).connections[0].status).toBe('unauthorized');
  });

  it('reads the Keychain password from the command output', async () => {
    const run: RunFile = async () => 'made-up-pw\n';
    expect(await readMiacKeychainPassword(run)).toEqual({
      kind: 'mac',
      password: 'made-up-pw',
    });
  });
});
