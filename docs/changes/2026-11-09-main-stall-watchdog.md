# Main-process stall watchdog

## Why

On Windows the whole window freezes now and then. Telemetry (`app.health`) shows the main process stalling for about 10.5 s, twice in half an hour on 2026-11-08, with no slow IPC or git call to explain it, and about 530 ms in most 10-minute reports. `window.unresponsive` never fired: Electron only raises it after roughly 15 s. Nothing recorded what the main thread was doing, so the cause could not be named. The leading suspect is the synchronous OpenCode database scan in `src/main/budget/openCode.ts`, but that is unproven, so this change captures evidence and fixes nothing.

## How it works

`src/main/diagnostics/stallWatchdog.ts` runs V8's sampling profiler on the main process all the time (one sample per 20 ms), from launch until quit.

- A 250 ms heartbeat notices when the event loop was blocked for 1 s or more. It then saves the last stretch of the profile (the stall plus 2 s) as `<userData>/diagnostics/stalls/stall-<UTC time>-<stall ms>.cpuprofile`. On Windows that is `%APPDATA%\Shellie\diagnostics\stalls`.
- Profiling must already be running when the stall starts: inspector commands cannot be serviced during a blocking native call. V8 samples from its own thread, so a blocked main thread is still captured.
- The profile is discarded and restarted every 10 minutes to bound memory. The newest 20 files are kept. A sleeping machine (`powerMonitor` suspend to resume) does not count as a stall.
- If the profiler cannot start or fails later, the watchdog stops and the app carries on.
- `SHELLIE_STALL_WATCHDOG=0` turns it off for a launch.

Open a file in Chrome DevTools (Performance, Load profile) or send it to whoever is debugging. Files stay on the machine and nothing is added to telemetry. They hold function names and script paths inside the app, no terminal or task content.

## Verified

- Unit tests with a fake clock and profiler, and one against the real inspector.
- Spike in Electron 44 with an inflated heap (60k functions, 350 MB): a 1.5 s blocking `execSync` was attributed to the right stack. A restart cost about 110 ms to start plus 30 ms to stop.
- The packaged-app smoke check (`src/main/smoke.ts`) now requires the profiler to record samples, so CI proves it on packaged Windows and macOS despite the disabled inspector CLI fuse.

## Known gaps

- A freeze with no stall file points away from the main process, most likely to the GPU process (WebGL terminals). This watchdog cannot see that.
- Stalls under 1 s, such as the roughly 530 ms ones, are not saved.
- A stall during the short profiler restart is not captured.
- A sleep that macOS or Windows does not announce through `suspend` can save a harmless profile of the gap.
