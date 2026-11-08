// Puts this machine's Electron zip in the download cache before packaging, retrying when GitHub is unavailable: the
// packager downloads it once with no retry, so a 503 failed the whole run (2026-11-08). The packager then finds it there.
// Run from CI before every make, through the same @electron/get and with the same checksums as the packager (forge.config.mts).
import { downloadArtifact, getHostArch } from '@electron/get';
import { readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/** Together about 7.5 minutes: long enough to outlast a short GitHub incident, short enough for the jobs' timeouts. */
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 240_000];
// A stalled connection never fails by itself.
const ATTEMPT_TIMEOUT_MS = 180_000;

/**
 * @template T
 * @param {() => Promise<T>} attempt
 * @param {{ delays?: number[], timeoutMs?: number, sleep?: (ms: number) => Promise<unknown>, log?: (line: string) => void }} [options]
 * @returns {Promise<T>} the first result; rejects with the last error once every delay is used up
 */
export async function withRetries(attempt, options = {}) {
  const {
    delays = RETRY_DELAYS_MS,
    timeoutMs = ATTEMPT_TIMEOUT_MS,
    sleep = wait,
    log = console.log,
  } = options;
  for (let tried = 0; ; tried++) {
    let timer;
    try {
      return await Promise.race([
        attempt(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no result after ${timeoutMs} ms`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (e) {
      if (tried >= delays.length) throw e;
      log(
        `Attempt ${tried + 1} failed: ${e.message}. Next in ${delays[tried] / 1000} s.`,
      );
      await sleep(delays[tried]);
    } finally {
      clearTimeout(timer);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const read = (file) =>
    JSON.parse(readFileSync(`node_modules/electron/${file}`, 'utf8'));
  const { version } = read('package.json');
  const zip = await withRetries(() =>
    downloadArtifact({
      version,
      artifactName: 'electron',
      checksums: read('checksums.json'),
      platform: process.platform,
      arch: getHostArch(),
    }),
  );
  console.log(`Electron ${version}: ${zip}`);
  // A timed-out attempt may still hold its connection open.
  process.exit(0);
}
