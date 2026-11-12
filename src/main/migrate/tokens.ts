import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ConnectionsFileSchema } from '../../shared/types';
import { writeAtomic } from '../fsRetry';

// One-off migration helpers for the rename from MIAC; kept out of the Platform interface on purpose, they go when the migration goes.

/** MIAC's safeStorage key: the Keychain password on macOS, the DPAPI-unprotected AES key on Windows. */
export type OldKey =
  | { kind: 'mac'; password: string }
  | { kind: 'win'; key: Buffer };

export type TokenMigration = 'migrated' | 'partial' | 'refused' | 'none';

const V10 = 'v10';

/** Chromium's macOS safeStorage format, which MIAC's tokens are in: "v10" + AES-128-CBC with a key derived from the Keychain password. */
export function decryptChromiumMac(cipher: Buffer, password: string): string {
  if (cipher.subarray(0, 3).toString() !== V10)
    throw new Error('not a v10 ciphertext');
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([d.update(cipher.subarray(3)), d.final()]).toString(
    'utf8',
  );
}

/** Chromium's Windows safeStorage format: "v10" + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag. */
export function decryptChromiumWin(cipher: Buffer, key: Buffer): string {
  if (cipher.subarray(0, 3).toString() !== V10)
    throw new Error('not a v10 ciphertext');
  if (cipher.length < 3 + 12 + 16) throw new Error('ciphertext too short');
  const nonce = cipher.subarray(3, 15);
  const tag = cipher.subarray(cipher.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([
    d.update(cipher.subarray(15, cipher.length - 16)),
    d.final(),
  ]).toString('utf8');
}

function decryptOld(cipher: Buffer, key: OldKey): string {
  return key.kind === 'mac'
    ? decryptChromiumMac(cipher, key.password)
    : decryptChromiumWin(cipher, key.key);
}

/** Runs a command and resolves its stdout; injectable so tests never touch the real Keychain or PowerShell. */
export type RunFile = (
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout: number },
) => Promise<string>;

export const runFile: RunFile = (file, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeout, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    ),
  );

/** Time to answer the Keychain prompt; boot waits on it, so it must not hang forever. */
export const KEYCHAIN_TIMEOUT_MS = 120_000;
export const DPAPI_TIMEOUT_MS = 30_000;

/** MIAC's key, from the Keychain item Electron made for it. macOS asks the user once. */
export async function readMiacKeychainPassword(
  run: RunFile = runFile,
): Promise<OldKey> {
  let out: string;
  try {
    out = await run(
      'security',
      [
        'find-generic-password',
        '-w',
        '-s',
        'miac Safe Storage',
        '-a',
        'miac Key',
      ],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
  } catch {
    throw new Error('MIAC Keychain item could not be read');
  }
  return { kind: 'mac', password: out.trim() };
}

/** The DPAPI blob in a Chromium `Local State`: `os_crypt.encrypted_key`, base64, after its "DPAPI" prefix. */
export function parseLocalStateKey(json: string): Buffer {
  const state = JSON.parse(json) as { os_crypt?: { encrypted_key?: unknown } };
  const encoded = state.os_crypt?.encrypted_key;
  if (typeof encoded !== 'string' || encoded.length === 0)
    throw new Error('Local State has no os_crypt.encrypted_key');
  const raw = Buffer.from(encoded, 'base64');
  if (raw.subarray(0, 5).toString('latin1') !== 'DPAPI')
    throw new Error('encrypted_key does not start with DPAPI');
  return raw.subarray(5);
}

const UNPROTECT =
  "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:SHELLIE_DPAPI_BLOB); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

/** MIAC's key on Windows: the DPAPI-protected AES key in MIAC's `Local State`, unprotected for the current user by Windows PowerShell 5.1. */
export async function readMiacWindowsKey(
  oldLocalStatePath: string,
  run: RunFile = runFile,
): Promise<OldKey> {
  const blob = parseLocalStateKey(await fs.readFile(oldLocalStatePath, 'utf8'));
  let out: string;
  try {
    // By full path: a powershell.exe earlier on PATH must not see the key.
    out = await run(
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      ['-NoProfile', '-NonInteractive', '-Command', UNPROTECT],
      {
        env: { ...process.env, SHELLIE_DPAPI_BLOB: blob.toString('base64') },
        timeout: DPAPI_TIMEOUT_MS,
      },
    );
  } catch {
    throw new Error('DPAPI could not unprotect MIAC key');
  }
  const key = Buffer.from(out.trim(), 'base64');
  if (key.length !== 32) throw new Error('MIAC key is not 32 bytes');
  return { kind: 'win', key };
}

/**
 * Re-encrypts the tokens in a copied MIAC `connections.json` with Shellie's key. A token that does not decrypt
 * (or every token, when the old key cannot be read) keeps its connection, marked unauthorized, so the user enters it again.
 * The file is written once, atomically, at the end: all tokens move or none do.
 */
export async function migrateTokens(opts: {
  file: string;
  readOldKey: () => Promise<OldKey>;
  encrypt: (plain: string) => Promise<Buffer>;
}): Promise<TokenMigration> {
  const doc = ConnectionsFileSchema.parse(
    JSON.parse(await fs.readFile(opts.file, 'utf8')),
  );
  if (doc.connections.length === 0) return 'none';
  let key: OldKey | null;
  try {
    key = await opts.readOldKey();
  } catch {
    key = null;
  }
  let failed = 0;
  for (const c of doc.connections) {
    try {
      if (key === null) throw new Error('no key');
      const plain = decryptOld(Buffer.from(c.tokenCiphertext, 'base64'), key);
      c.tokenCiphertext = (await opts.encrypt(plain)).toString('base64');
    } catch {
      c.status = 'unauthorized';
      failed++;
    }
  }
  await writeAtomic(opts.file, JSON.stringify(doc, null, 2), '.tokens');
  if (key === null) return 'refused';
  return failed === 0 ? 'migrated' : 'partial';
}
