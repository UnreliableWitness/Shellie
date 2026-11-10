/** The subset of Electron's crashReporter used here. */
export type CrashReporterLike = {
  start(options: { uploadToServer: boolean }): void;
};

/**
 * Writes a minidump to the app's Crashpad folder when any of its processes crashes, because a native crash leaves
 * no other trace of where it happened. Dumps stay on this machine: they can hold pieces of memory, such as terminal
 * output, so nothing may upload them.
 */
export function startLocalCrashDumps(
  reporter: CrashReporterLike,
  log: (error: unknown) => void,
): void {
  try {
    reporter.start({ uploadToServer: false });
  } catch (e) {
    log(e);
  }
}
