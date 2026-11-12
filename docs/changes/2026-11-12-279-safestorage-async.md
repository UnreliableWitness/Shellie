# Secrets at rest use Electron's async safeStorage API

Every secret Shellie keeps encrypted (Azure DevOps tokens in `connections.json`, repo secrets in `secrets.json`, the cost server key in `cost-server.json`, the phone reader secret in `reader.json`, and the one-off re-encryption of MIAC tokens) now goes through `safeStorage.isAsyncEncryptionAvailable`, `encryptStringAsync` and `decryptStringAsync` (issue #279, 2026-11-12, `agent/issues/279-electron-1-96-0-warns-that-sync-safestor`). Electron 45 deprecates the sync calls and will remove them, and on 1.96.0 each start logged three deprecation warnings that reached exception telemetry. The adapter is `src/main/services/safeCrypto.ts`. `TokenCrypto` is async now.

The stored format is unchanged: Electron documents that what `encryptString` wrote decrypts with `decryptStringAsync`, so nothing has to be entered again. The `shouldReEncrypt` hint of `decryptStringAsync` is ignored: values are not re-encrypted on read.

The callers of the secret, cost server and reader stores stay synchronous, because the leak watch's terminal output filter and the budget settings cannot wait for a decrypt. Those three stores decrypt their values once when they load (and keep the plaintext of a value they save) in main-process memory. A value that cannot be decrypted is unreadable for the rest of the run, as before. `ConnectionStore.assertCanSave` is async now. Tokens are still decrypted on each use.

The three `safeStorage ... is deprecated` exceptions should stop appearing in telemetry from this release on. No telemetry filter was added, and `docs/telemetry.md` does not change.

Not verified: in the app itself, on macOS against a real Keychain, or on Windows and Linux, where the async API may use another backend. This was checked only through the unit tests with fake crypto.
