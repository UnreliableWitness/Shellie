import type { SafeStorage } from 'electron';
import type { TokenCrypto } from './ConnectionStore';

/**
 * Secrets at rest (tokens, repo secrets, the cost server key, the reader secret) through Electron's async
 * safeStorage. The sync calls are deprecated; what they wrote decrypts with the async ones.
 */
export function safeCrypto(
  s: Pick<
    SafeStorage,
    'isAsyncEncryptionAvailable' | 'encryptStringAsync' | 'decryptStringAsync'
  >,
): TokenCrypto {
  return {
    available: () => s.isAsyncEncryptionAvailable(),
    encrypt: (plain) => s.encryptStringAsync(plain),
    decrypt: async (cipher) => (await s.decryptStringAsync(cipher)).result,
  };
}
