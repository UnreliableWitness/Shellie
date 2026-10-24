# macOS release

Every release carries a signed, notarized Apple Silicon build next to the Windows installer: `Shellie.dmg` (first
install) and `Shellie-darwin-arm64-<version>.zip` (what auto-update downloads). Intel Macs are not supported.

## Install

Open `Shellie.dmg` from the [latest release](https://github.com/UnreliableWitness/Shellie/releases/latest) and drag
Shellie to Applications. Start it from there.

Updates only work from `/Applications`. Started from the mounted DMG (or any other place), Shellie checks nothing and
shows a card, "Move Shellie to Applications to get updates", with **Move** (moves the app and relaunches it from
Applications) and **Not now** (hides the card until the next launch).

## How it ships

- `.github/workflows/ci.yml` job `macos-release` runs on `macos-latest` after `windows-release` and reuses its tag, so
  both platforms carry the same version. If Windows made no release, it publishes nothing.
- Signing is on when all the secrets below exist (`MAC_SIGN=true`). It imports the certificate into a temporary keychain
  (deleted in an `always()` step), signs with the hardened runtime (`assets/entitlements.mac.plist`), notarizes with the
  App Store Connect API key (`tools/forge/macSigning.mjs`) and uploads the DMG and ZIP to the run's release with
  `gh release upload --clobber`.
- Without all the secrets the build is unsigned and uploaded as a run artifact only, never to a Release. The step
  summary names the missing secrets (names only).
- A failed macOS job never touches the Windows release. Retry it with **Re-run failed jobs**; it uploads to the existing
  release.
- Auto-update (`src/main/autoUpdate.ts`) uses update.electronjs.org (`darwin-arm64`), same schedule as Windows.

## Owner setup

Once, about 20 minutes:

1. In Xcode or developer.apple.com, create a **Developer ID Application** certificate; export it with its private key
   from Keychain Access as a `.p12` with a password.
2. In App Store Connect › Users and Access › Integrations, create an **App Store Connect API key** with the Developer
   role; download the `.p8` and note the Key ID and Issuer ID.
3. Add to the GitHub `release` environment as secrets: `APPLE_CERT_P12_BASE64` (`base64 -i cert.p12`),
   `APPLE_CERT_PASSWORD`, `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; and as a variable
   `APPLE_TEAM_ID`.
4. Push to `main`; check that the release has the `.dmg` and `.zip`.

## Manual check

Not done yet; it needs the setup above.

1. Install vN from the DMG into `/Applications` and start it.
2. Merge something to `main`. Within about 25 minutes (30 s first check, then every 10 minutes, plus the build) the update card
   appears.
3. **Restart and update** relaunches on vN+1. This proves `quitAndInstall` gets past the `will-quit` hold (up to 2 s)
   in `src/main.ts`.
4. Launch another copy from the mounted DMG: the Move card shows; **Move** relaunches it from `/Applications`.
5. `codesign --verify --deep --strict /Applications/Shellie.app` and `spctl --assess` pass.

## Known gaps

- The first signed build, notarization and the vN to vN+1 update are unverified until the owner's setup.
- Entitlements are `allow-jit` and `allow-unsigned-executable-memory` only. `disable-library-validation`, and
  microphone, camera or Apple Events for CLIs run in terminals, may be needed; the first signed run decides.
- The DMG itself is not signed or notarized (the `.app` inside is).
- No Intel build, no delta updates.
