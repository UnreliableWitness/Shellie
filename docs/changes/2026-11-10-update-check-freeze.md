# Update checks no longer freeze the window on Windows

## Why

Stall profiles from a Windows machine (`docs/changes/2026-11-09-main-stall-watchdog.md`) showed the 10.5 s and 22.6 s whole-window freezes were all `spawn` of Squirrel's `Update.exe`, started by Electron's `autoUpdater.checkForUpdates` on the main thread. Shellie checks 30 s after launch, every 10 minutes and on wake, so an open app froze about every 10 minutes.

## How it works

On Windows, `startAutoUpdate` first asks the feed (`update.electronjs.org/<repo>/win32-x64/<version>`) with `net.fetch`, which does not block. The feed answers 204 when this version is current and 200 with the release's name when a newer one exists.

- `Update.exe` starts only when there is a newer version that is not already downloaded and waiting for a restart.
- Anything unclear (offline, timeout, another status, an unreadable name) runs the full check as before, so this cannot stop updates.
- macOS is unchanged: Squirrel.Mac starts no process.

## Verified

- Unit tests for the decision and for reading the feed's answers.
- The feed's real answers, by curl: 204 at the current version, 200 at an older one, for `win32-x64` and `darwin-arm64`.

## Known gaps

- The freeze still happens on the check that does fetch a new release, at most a few times a day. Why starting `Update.exe` takes 10 s or more is unknown.
- Not yet observed on an installed Windows app.
