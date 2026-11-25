# A stored token that cannot be decrypted: say why, and stop retrying

Issue #380, branch `agent/issues/380-stored-azure-devops-token-cannot-be-decr`, 2026-11-25.

## Why

Application Insights showed `TokenUnavailableError` on `workItems:types` (14 in 24 h for one user, 14 of 36 calls failing) and on `brain:discover`, with `home.failed` `unreachable` alongside. The stored Azure DevOps token could not be decrypted, but the bare `catch {}` in `ConnectionStore.token()` and `BrainHomeStore.token()` dropped the reason, Home reported it as `unreachable`, and every call tried to decrypt again and failed again. The suspected cause, a changed OS keychain or safeStorage key, is not confirmed.

## What changed

- `TokenUnavailableError` takes the decrypt error as its `cause` and keeps `reason`: the cause's type and message (at most 200 characters), never the token or its ciphertext.
- A failed IPC call that failed on such an error carries `reason` in its exception properties.
- `ConnectionStore` remembers a connection whose token failed to decrypt and fails at once, without decrypting or calling Azure DevOps, until the token is saved again (or the connection is removed, or the app restarts). That covers `workItems:types`, `brain:discover` and every other call through the connection. The connection is still marked `unauthorized` by `withConnection`, so Settings and the footer show it red as before.
- Home reports this failure as `home.failed` kind `token` instead of `unreachable`; its card shows "Stored token could not be decrypted; enter it again".
- `docs/telemetry.md` is updated.

## Verified

- `npm test`, `npm run typecheck`, `npm run lint`.
- New tests: the reason and cause are kept and the token is not in them, and a second `token()` does not decrypt until a save (`ConnectionStore.test.ts`); Home's kind `token` (`HomeService.test.ts`); the IPC exception's `reason` (`helpers.test.ts`); a second `workItems:types` neither decrypts nor reaches the server, and works again after the token is saved (`handlers.part3.test.ts`).

## Known gaps

- Not run in the app, and the macOS keychain behaviour was not reproduced. Tokens are not repaired or re-encrypted.
- A decrypt failure that would have passed on a retry (a keychain that was only locked for a moment) now needs the token entered again, or a restart.
- The brain home's token (`BrainHomeStore`) keeps its cause and reason but is still decrypted on every call.
