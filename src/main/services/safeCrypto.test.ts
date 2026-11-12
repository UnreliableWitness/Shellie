import { describe, expect, it, vi } from 'vitest';
import { safeCrypto } from './safeCrypto';

const fakeSafeStorage = () => ({
  isAsyncEncryptionAvailable: vi.fn(async () => true),
  encryptStringAsync: vi.fn(async (s: string) => Buffer.from(`enc:${s}`)),
  decryptStringAsync: vi.fn(async (b: Buffer) => ({
    result: b.toString().slice(4),
    shouldReEncrypt: false,
  })),
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
  decryptString: vi.fn((b: Buffer) => b.toString().slice(4)),
});

describe('safeCrypto', () => {
  it('uses only the async safeStorage calls (the sync ones are deprecated)', async () => {
    const s = fakeSafeStorage();
    const crypto = safeCrypto(s);
    expect(await crypto.available()).toBe(true);
    const cipher = await crypto.encrypt('tok');
    expect(await crypto.decrypt(cipher)).toBe('tok');
    expect(s.isAsyncEncryptionAvailable).toHaveBeenCalledOnce();
    expect(s.encryptStringAsync).toHaveBeenCalledWith('tok');
    expect(s.decryptStringAsync).toHaveBeenCalledWith(cipher);
    expect(s.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(s.encryptString).not.toHaveBeenCalled();
    expect(s.decryptString).not.toHaveBeenCalled();
  });

  it('decrypts what the sync API wrote', async () => {
    const s = fakeSafeStorage();
    const old = s.encryptString('written by 1.95');
    expect(await safeCrypto(s).decrypt(old)).toBe('written by 1.95');
  });

  it('passes a failing decrypt on as a rejection', async () => {
    const s = fakeSafeStorage();
    s.decryptStringAsync.mockRejectedValueOnce(new Error('no key'));
    await expect(safeCrypto(s).decrypt(Buffer.from('x'))).rejects.toThrow(
      'no key',
    );
  });
});
