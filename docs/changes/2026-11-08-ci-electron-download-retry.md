# CI: Electron's download retries

On 2026-11-08 a "Release now" run failed on macOS with a 503 for Electron's zip during a GitHub incident, after every test had passed. Packaging downloads Electron once and has no retry.

## How it works

- `tools/release/fetch-electron.mjs` runs before every make in `ci.yml` (macOS test, Windows installer, Windows release, macOS release). It puts this machine's Electron zip in the `@electron/get` cache: five attempts over about 7.5 minutes of waiting, three minutes at most per attempt, because a stalled connection does not fail by itself.
- `packagerConfig.download.checksums` in `forge.config.mts` uses the `checksums.json` the electron package ships. Without it, `@electron/get` fetches `SHASUMS256.txt` from GitHub again even for a cached zip, so packaging would still have depended on GitHub. The zip is checked against the same hashes, now pinned by `package-lock.json`.
- The script lives in `tools/release/` so it does not count as an app change (`tools/release/needs-release.mjs`).

## Verified

- On an empty cache the script downloads the zip, and `electron-forge package --arch=arm64` then logs a cache hit and no download from GitHub.
- `withRetries` has unit tests: first result, delays in turn, last error, stalled attempt.

## Known gaps

- `npm ci` and the signing and notarizing services are other network steps in the same jobs, and do not retry here.
- An outage longer than the retries still fails the run; run the failed jobs again once GitHub is back.
