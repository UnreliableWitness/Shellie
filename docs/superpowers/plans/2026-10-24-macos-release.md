# macOS Release Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every release carries a signed, notarized Apple Silicon `Shellie.dmg` and update `.zip`, and packaged macOS builds update themselves like Windows builds.

**Architecture:** `autoUpdate.ts` learns darwin (gated on the app being in /Applications, else a "Move to Applications" card). `forge.config.mts` gains a DMG maker and env-gated `osxSign`/`osxNotarize` built by a small tested helper. CI gets a `macos-release` job that runs after `windows-release`, reuses its tag, signs in a temporary keychain and uploads to the same release.

**Tech Stack:** Electron Forge 7 (`@electron-forge/maker-dmg`, `@electron/osx-sign`, `@electron/notarize` via `osxNotarize`), GitHub Actions `macos-latest` (arm64), Vitest, React.

**Spec:** `docs/superpowers/specs/2026-10-24-macos-release-design.md`

## Global Constraints

- Apple Silicon only: every macOS build command passes `--arch=arm64`.
- Never publish an unsigned macOS build to a Release; unsigned runs upload a run artifact only.
- A failed macOS job must never block, delay or alter the Windows release.
- No certificate, password or key in the repo, in logs or on a command line; the `.p12` and `.p8` are written to `$RUNNER_TEMP` and the temporary keychain is deleted in an `always()` step.
- Secret names (environment `release`): `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; variable `APPLE_TEAM_ID`.
- Update zip name stays Forge's default `Shellie-darwin-arm64-<version>.zip` (update.electronjs.org matches `/.*-(mac|darwin|osx).*\.zip$/i`, `-arm64` = darwin-arm64).
- Notarization uses the App Store Connect API key (`appleApiKey`, `appleApiKeyId`, `appleApiIssuer`), never Apple ID + app password.
- Copy (exact): card text "Move Shellie to Applications to get updates", buttons "Move" and "Not now".
- Windows behaviour of `autoUpdate.ts` (Squirrel first-run rule, intervals, #126 checks after download) is unchanged.

## Review Focus

1. App launched from the mounted DMG or from ~/Downloads (translocated): no update checks, the Move card shows; after Move, the app relaunches from /Applications and checks normally. Pinned in Task 1 (`canAutoUpdate` false, `needsMoveToApplications` true) and Task 2 (card test).
2. Move fails or the user cancels the system's replace dialog: no crash, the card stays, the error is logged. Pinned in Task 2 (`update:moveToApplications` returns false → card stays).
3. Signing switched on with one secret missing: CI treats it as unsigned and names the missing secrets; the helper refuses partial config instead of half-signing. Pinned in Task 3 (`macSigning` tests).
4. `windows-release` made no release (tag empty) or failed: `macos-release` uploads nothing. Pinned in Task 4 (job `if:`), checked by reading the workflow.
5. Restart and update on macOS with the `will-quit` 2 s hold: the update still installs. Not testable before the owner's setup; Task 5 adds it to the manual check in `docs/macos-release.md`.

---

### Task 1: Darwin in the updater

**Files:**
- Modify: `src/main/autoUpdate.ts` (`AutoUpdateDeps`, `canAutoUpdate`, header comment)
- Test: `src/main/autoUpdate.test.ts`

**Interfaces:**
- Produces: `AutoUpdateDeps.inApplicationsFolder?: boolean` (read on darwin only; undefined counts as false); `canAutoUpdate(d: Pick<AutoUpdateDeps,'isPackaged'|'platform'|'enabled'|'inApplicationsFolder'>): boolean`; `needsMoveToApplications(d: same Pick): boolean`.

- [ ] **Step 1: Write the failing tests** (replace the "on macOS" parts of the existing `canAutoUpdate` and `does nothing in dev, on macOS or when turned off` tests)

```ts
it('is on for packaged Windows builds and packaged macOS builds in Applications', () => {
  expect(canAutoUpdate({ isPackaged: true, platform: 'darwin', enabled: undefined, inApplicationsFolder: true })).toBe(true);
  expect(canAutoUpdate({ isPackaged: true, platform: 'darwin', enabled: undefined, inApplicationsFolder: false })).toBe(false);
  expect(canAutoUpdate({ isPackaged: true, platform: 'darwin', enabled: undefined })).toBe(false);
  expect(canAutoUpdate({ isPackaged: true, platform: 'darwin', enabled: false, inApplicationsFolder: true })).toBe(false);
  expect(canAutoUpdate({ isPackaged: false, platform: 'darwin', enabled: undefined, inApplicationsFolder: true })).toBe(false);
  expect(canAutoUpdate({ isPackaged: true, platform: 'linux', enabled: undefined, inApplicationsFolder: true })).toBe(false);
});
it('asks to move only packaged macOS builds outside Applications that would update', () => {
  expect(needsMoveToApplications({ isPackaged: true, platform: 'darwin', enabled: undefined, inApplicationsFolder: false })).toBe(true);
  expect(needsMoveToApplications({ isPackaged: true, platform: 'darwin', enabled: undefined, inApplicationsFolder: true })).toBe(false);
  expect(needsMoveToApplications({ isPackaged: true, platform: 'darwin', enabled: false, inApplicationsFolder: false })).toBe(false);
  expect(needsMoveToApplications({ isPackaged: false, platform: 'darwin', enabled: undefined, inApplicationsFolder: false })).toBe(false);
  expect(needsMoveToApplications({ isPackaged: true, platform: 'win32', enabled: undefined, inApplicationsFolder: false })).toBe(false);
});
it('on macOS in Applications: sets the darwin-arm64 feed and checks after the first delay', () => {
  // Use the file's existing fake updater and timers helpers.
  // expect(updater.setFeedURL).toHaveBeenCalledWith({ url: updateFeedUrl('darwin', 'arm64', '1.2.0') });
  // advance FIRST_CHECK_DELAY_MS → expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  // and with inApplicationsFolder false: startAutoUpdate(...) returns null, setFeedURL never called.
});
```

- [ ] **Step 2: Run** `npx vitest run src/main/autoUpdate.test.ts` — Expected: FAIL (`needsMoveToApplications` not exported; darwin returns false).
- [ ] **Step 3: Implement** in `src/main/autoUpdate.ts`. Update the header comment and the `canAutoUpdate` doc line to cover Squirrel.Mac (zip asset, same-identity signing, /Applications rule).
- [ ] **Step 4: Run** the test file — Expected: PASS. Then `npm run typecheck`.
- [ ] **Step 5: Commit** `git commit -m "Auto-update packaged macOS builds in Applications"`

### Task 2: Move to Applications card

**Files:**
- Modify: `src/main.ts` (pass `inApplicationsFolder: process.platform === 'darwin' && app.isInApplicationsFolder()` to `startAutoUpdate`; handlers), `src/shared/ipc.ts`, the main IPC handler module that serves `update:status` (find it from `update: { pending, install }` in `src/main.ts`), `src/renderer/components/Notices.tsx`, `docs/telemetry.md`
- Test: `src/renderer/components/Notices.test.tsx`, the handler module's test

**Interfaces:**
- Consumes: `needsMoveToApplications` (Task 1).
- Produces IPC: `'update:needsMove': { args: []; result: boolean }`; `'update:moveToApplications': { args: []; result: boolean }` (true when the move started; Electron relaunches the app from /Applications; false on refusal or error, which main logs).
- Handler deps added next to `update.pending/install`: `needsMove(): boolean`, `moveToApplications(): boolean` (main wraps `app.moveToApplicationsFolder()` in try/catch).

- [ ] **Step 1: Write the failing tests** in `Notices.test.tsx`:
  - `shows the Move card when update:needsMove is true` → text "Move Shellie to Applications to get updates", buttons "Move", "Not now".
  - `Not now hides it for this launch` → after click the text is gone.
  - `Move calls update:moveToApplications and keeps the card when it returns false`.
  - `no card when update:needsMove is false`.
  And in the handler test: `update:needsMove` and `update:moveToApplications` return the deps' values.
- [ ] **Step 2: Run** `npx vitest run src/renderer/components/Notices.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** a `MoveNotice` beside `UpdateNotice` with the same `notice notice-update` markup; telemetry `track('update.move')` on Move, `track('update.moveLater')` on Not now (renderer events only, nothing new in main). Add both events to `docs/telemetry.md`.
- [ ] **Step 4: Run** both test files, `npm run typecheck`, `npm run lint` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Offer to move Shellie to Applications so it can update"`

### Task 3: Signed DMG and ZIP from Forge

**Files:**
- Create: `tools/forge/macSigning.mjs`, `tools/forge/macSigning.test.ts`, `assets/entitlements.mac.plist`
- Modify: `forge.config.mts`, `package.json` (devDependency `@electron-forge/maker-dmg` at the same major as the other `@electron-forge/*` packages)

**Interfaces:**
- Produces: `macSigning(env: NodeJS.ProcessEnv): { osxSign: object; osxNotarize: { appleApiKey: string; appleApiKeyId: string; appleApiIssuer: string } } | undefined`. Undefined unless `env.MAC_SIGN === 'true'`; with `MAC_SIGN` true it throws `Error('Mac signing is on but missing: <NAMES>')` listing any of `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` that are empty.
- `osxSign`: `optionsForFile` returning `{ hardenedRuntime: true, entitlements: 'assets/entitlements.mac.plist' }` for every file (node-pty's `.node` and `spawn-helper` included).
- Entitlements: `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`; add `com.apple.security.cs.disable-library-validation` only if the signed app's smoke test fails without it (record which in the commit message).

- [ ] **Step 1: Write the failing tests** `macSigning.test.ts`: off without `MAC_SIGN`; off with `MAC_SIGN: 'false'`; with all three set returns `osxNotarize` holding exactly those values and an `osxSign` whose `optionsForFile('x')` has `hardenedRuntime: true` and the entitlements path; with `MAC_SIGN: 'true'` and `APPLE_API_ISSUER` empty throws `/missing: APPLE_API_ISSUER/`.
- [ ] **Step 2: Run** `npx vitest run tools/forge/macSigning.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `macSigning.mjs`; in `forge.config.mts` spread its result into `packagerConfig`, add `new MakerDMG({ format: 'ULFO' }, ['darwin'])` (name `Shellie`, default layout with the Applications link) before `MakerZIP`.
- [ ] **Step 4: Verify locally, unsigned:** `npx electron-forge make --arch=arm64` then `ls out/make` — Expected: a `.dmg` and `zip/darwin/arm64/Shellie-darwin-arm64-<version>.zip`; `node tools/forge/smoke.mjs` prints `SHELLIE_SMOKE_OK`. `npm test`, `npm run typecheck` pass.
- [ ] **Step 5: Commit** `git commit -m "Build a DMG and switch on macOS signing and notarization from the environment"`

### Task 4: CI release job

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `MAC_SIGN`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (Task 3).
- Produces: `windows-release` job output `tag` (= `RELEASE_TAG`, empty when no release).

- [ ] **Step 1: `test` job:** the macOS step runs `npx electron-forge make --arch=arm64` (unsigned) instead of `package`, then `node tools/forge/smoke.mjs`.
- [ ] **Step 2: `windows-release`:** add `outputs: { tag: ${{ steps.release.outputs.tag }} }`; give the Release step `id: release` and have it write `tag=$env:TAG` to `$env:GITHUB_OUTPUT` after `gh release create` succeeds.
- [ ] **Step 3: New job `macos-release`:** `needs: windows-release`, same `if:` as `windows-release` plus `needs.windows-release.outputs.tag != ''`; `runs-on: macos-latest`, `environment: release`, `permissions: contents: write`, `concurrency: { group: macos-release, cancel-in-progress: false }`, `timeout-minutes: 45`. Steps, in order:
  1. checkout (same pinned SHA as the other jobs, `ref: ${{ github.sha }}`), setup-node 24 with npm cache, `npm ci`.
  2. `npm version ${TAG#v} --no-git-tag-version --allow-same-version`.
  3. "Decide on signing": `MAC_SIGN=true` in `$GITHUB_ENV` only when all five secrets and `APPLE_TEAM_ID` are non-empty; otherwise a step-summary line naming the missing ones (names only).
  4. If signing: decode the `.p12` and `.p8` into `$RUNNER_TEMP`; `security create-keychain` with a random password, `set-keychain-settings -lut 21600`, `unlock-keychain`, `import ... -T /usr/bin/codesign`, `set-key-partition-list -S apple-tool:,apple:`, add it to the user search list; export `APPLE_API_KEY=$RUNNER_TEMP/AuthKey.p8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
  5. `npx electron-forge make --arch=arm64` with `APPINSIGHTS_CONNECTION_STRING`.
  6. `node tools/forge/smoke.mjs`.
  7. If signing: `codesign --verify --deep --strict --verbose=2` on the `.app`, `xcrun stapler validate` on the `.app`, `spctl --assess --type execute -v` on the `.app`.
  8. upload-artifact `Shellie-mac-${{ github.sha }}` (the `.dmg` and `.zip`).
  9. If signing: `gh release upload "$TAG" <dmg> <zip> --clobber`, with the DMG renamed to `Shellie.dmg`.
  10. `if: always()`: delete the temporary keychain and the decoded files.
- [ ] **Step 4: Verify:** `npx --yes @action-validator/cli .github/workflows/ci.yml` (or `actionlint` if installed) — Expected: no errors. Push the branch: the PR's `test (macos-latest)` job passes with the DMG maker.
- [ ] **Step 5: Commit** `git commit -m "Release a signed macOS build after the Windows release"`

### Task 5: Docs and status

**Files:**
- Create: `docs/macos-release.md`
- Modify: `CLAUDE.md` (Status line and known gaps), `README.md` only if it has install instructions

- [ ] **Step 1:** `docs/macos-release.md`: install (open `Shellie.dmg`, drag to Applications); owner setup copied from the spec with the exact secret names; manual check: install vN from the DMG into /Applications, merge to main, within about 25 minutes the update card appears, Restart and update relaunches on vN+1 (this proves `quitAndInstall` gets past the `will-quit` hold); launching from the DMG shows the Move card and Move relaunches from /Applications.
- [ ] **Step 2:** CLAUDE.md: a status entry for the macOS release (what ships, signing gated on the secrets, Move card) and known gaps (first signed build and the vN to vN+1 update unverified until the owner's setup).
- [ ] **Step 3: Commit** `git commit -m "Document the macOS release and owner setup"`
