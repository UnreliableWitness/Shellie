# Local crash dumps

## Why

A renderer ran out of memory on Windows (`process.gone`, reason `oom`) and another session ended with no quit event. Telemetry records that a process died but not where, and a crash of the main process cannot report itself at all.

## How it works

`src/main/diagnostics/crashDumps.ts` starts Electron's `crashReporter` with `uploadToServer: false`, right after the data folder is set. Any Shellie process that crashes then leaves a `.dmp` file under `<userData>/Crashpad` (`%APPDATA%\Shellie\Crashpad` on Windows; the subfolder is `pending` on macOS). Crashpad limits how much it keeps.

A dump can hold pieces of the process's memory, such as terminal output, tokens or file contents. It never leaves the machine by itself. Handle one like a secret when sharing it.

## Verified

- Unit tests: it never uploads and a failure to start is harmless.
- In the dev app on macOS, a forced renderer crash and a forced main-process crash each left a dump.

## Known gaps

- A JavaScript out-of-memory dump shows the native stack at the moment of failure, which may not name the JavaScript that allocated the memory.
- Not yet observed on an installed Windows app.
