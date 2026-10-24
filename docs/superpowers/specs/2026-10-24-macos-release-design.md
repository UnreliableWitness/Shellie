# macOS release build

Date: 2026-10-24. Status: design.

## Intent

Every release on GitHub carries a macOS build next to the Windows installer, for the owner and for teammates. It is signed with the owner's Apple Developer ID and notarized, so it opens without a Gatekeeper warning, and it updates itself the way the Windows build does: a quiet "Restart and update / Later" card, no dialog.

Why now: development happens on macOS and some teammates use Macs; today they have to build from source.

## Decided (by the owner)

- Users: the owner and teammates, so signed, notarized and auto-updating, not a developer-only artifact.
- Apple Developer account: the owner has one.
- Architecture: Apple Silicon (`arm64`) only. No Intel, no universal build.

## Goals

- A `push` to `main` (and a hand-pushed `vX.Y.Z` tag) produces, in the same GitHub Release as the Windows assets:
  - `Shellie.dmg` (drag to Applications) for installing;
  - the `.zip` that the update feed serves to Squirrel.Mac.
- Both carry the release's version (the one `tools/release/next-version.mjs` or the tag gives the Windows job).
- Signed with a Developer ID Application certificate, hardened runtime, notarized and stapled. `node-pty`'s unpacked `.node` binaries and `spawn-helper` are signed too and still spawn a pty after signing.
- Packaged macOS builds auto-update through update.electronjs.org (`darwin-arm64` feed), with the existing card, `update:*` IPC and `"autoUpdate": false` switch.
- Owner setup steps written down, like the Windows signing steps.

## Non-goals

- Intel or universal builds.
- Mac App Store, Homebrew cask.
- Delta updates.
- Changing the Windows release.

## Anti-goals

- An unsigned build published to the Release. The updater cannot use it and teammates would get the "can't be opened" dialog. Until the Apple secrets exist, the macOS release job builds, smoke-tests and uploads a run artifact only.
- A failed macOS build blocking or delaying the Windows release (most users are on Windows).
- Certificates, passwords or API keys in the repo, in logs or on the command line.

## Design

### CI (`.github/workflows/ci.yml`)

- New job `macos-release` on `macos-latest` (arm64 runner), same triggers as `windows-release` (push to `main` or a `v*` tag), in the `release` environment.
- It runs after `windows-release` (`needs`): `windows-release` gets a job output `tag` (its `RELEASE_TAG`, empty when it made no release), so both platforms carry the same version and only one job computes it. `macos-release` checks out `github.sha`, sets that version in `package.json` (as the Windows job does) and builds. When the tag is empty, or `windows-release` failed, it publishes nothing (my call: a Windows failure stops the macOS release, never the other way round; cost if wrong: a Windows-only CI break also holds back Mac users until the next push).
- Its own concurrency group `macos-release`. Uploads always go to the run's own tag, so two quick merges cannot mix assets; the feed takes the newest release that has a Mac zip.
- A failed `macos-release` is retried with GitHub's "Re-run failed jobs"; it uploads to the existing release (`gh release upload --clobber`).
- Signing switches on when the secrets below exist (same pattern as the Windows "Decide on signing" step). Signed: it uploads the `.dmg` and the `.zip` to the existing release with `gh release upload`. Unsigned: run artifact only.
- A failure in `macos-release` leaves the Windows release in place; the next push to `main` releases both again.
- The `test` job's macOS step runs `electron-forge make --arch=arm64` unsigned (instead of `package`) and smoke-tests the result, so a broken DMG or ZIP maker shows on the PR, not at release. No installer artifact on PRs (my call: saves storage; cheap to add later).

### Packaging (`forge.config.mts`)

- `osxSign` and `osxNotarize` in `packagerConfig`, only when the signing env vars are set (like `windowsSign`).
- Hardened runtime with the entitlements Electron needs (`com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation` if node-pty requires it): exact list is the builder's to confirm by running the signed app.
- Makers on darwin: `MakerDMG` (new dependency `@electron-forge/maker-dmg`) and the existing `MakerZIP`.
- `node tools/forge/smoke.mjs` runs on the signed `.app` (it must still load node-pty and spawn a pty). `codesign --verify --deep --strict` and `spctl --assess` (or `xcrun stapler validate`) check the result.
- Always `--arch=arm64`, never the host default.
- Asset names: update.electronjs.org (`src/asset-platform.ts`, checked 2026-10-24) takes a `.zip` matching `/.*-(mac|darwin|osx).*\.zip$/i`, `-arm64` in the name meaning `darwin-arm64`. MakerZIP's default `Shellie-darwin-arm64-<version>.zip` matches; keep it. The `.dmg` is ignored by the feed. The service does not check signatures; Squirrel.Mac requires the running app and the update to be signed by the same identity, hence the anti-goal.
- Notarization uses the App Store Connect API key (`osxNotarize` with `appleApiKey`, `appleApiKeyId`, `appleApiIssuer`), not an Apple ID and app password.

### Auto-update (`src/main/autoUpdate.ts`)

- `canAutoUpdate` allows `darwin` as well as `win32`. On darwin the Squirrel first-run rule does not apply.
- Squirrel.Mac cannot update an app run from the mounted `.dmg` or a translocated location. When `app.isInApplicationsFolder()` is false, the app does not check for updates and shows one quiet card in the notice corner: "Move Shellie to Applications to get updates", with Move (`app.moveToApplicationsFolder()`) and Not now; Not now hides it until the next launch (my call: a silent stop would leave teammates on old versions without knowing; cost if wrong: one extra card).
- Restart and update must get past `main.ts`'s quit handlers (`will-quit` holds the quit up to 2 s for telemetry and time writes; `before-quit` kills terminals). The builder makes sure `quitAndInstall` still installs on macOS with them in place; the vN to vN+1 manual check proves it.
- `autoUpdate.test.ts` asserts darwin never updates; those tests change.
- Telemetry: existing update events gain nothing new beyond the platform they already carry; check `docs/telemetry.md`.

### Owner setup (in this spec, then copied to `docs/macos-release.md`)

Steps the owner does once, about 20 minutes:

1. In Xcode or developer.apple.com, create a **Developer ID Application** certificate; export it with its private key from Keychain Access as a `.p12` with a password.
2. In App Store Connect › Users and Access › Integrations, create an **App Store Connect API key** with the Developer role; download the `.p8` and note the Key ID and Issuer ID.
3. Add to the GitHub `release` environment as secrets: `APPLE_CERT_P12_BASE64` (`base64 -i cert.p12`), `APPLE_CERT_PASSWORD`, `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; and as a variable `APPLE_TEAM_ID`.
4. Push to `main`; check that the release has the `.dmg` and `.zip`.

The job imports the certificate into a temporary keychain that is deleted at the end of the job.

### Docs and status

- `docs/macos-release.md`: install (open the `.dmg`, drag to Applications), the owner setup, and a manual check: install vN, release vN+1, see the update card, restart.
- CLAUDE.md status line and known gaps.

## Error handling

- Notarization rejected or timed out: the job fails with notarytool's log printed (`xcrun notarytool log`), the Windows release stays.
- Missing or partial secrets: treated as unsigned, with a summary line naming which are missing (names only).
- Update check fails on macOS: same behaviour as Windows (logged, one quiet notice).

## Left to the builder

- Exact entitlements, notarize tool options, DMG layout (background art is out of scope; the default layout with an Applications link is fine).
- How the job hands the tag over and how it waits for the release to exist.
- Test shape for `canAutoUpdate` and the Applications-folder rule.

## Open items

- The first signed build and an end-to-end update (vN to vN+1) can only be checked after the owner's setup.
