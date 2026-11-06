import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathExists, renameWithRetry } from '../fsRetry';

/** Chromium's own entries in the profile folder; everything else is the app's. */
const CHROMIUM = [
  /^Cache$/,
  /^Code Cache$/,
  /^GPUCache$/,
  /^GPUPersistentCache$/,
  /^blob_storage$/,
  /^Cookies/,
  /^Session Storage$/,
  /^Dawn/,
  /^Graphite/,
  /^DIPS/,
  /^Trust Tokens/,
  /^Shared Dictionary$/,
  /^Network Persistent State$/,
  /^Preferences$/,
  /^DevToolsActivePort$/,
  /^declarative_performance_observer/,
  /^SingletonLock$/,
  /^SingletonSocket$/,
  /^SingletonCookie$/,
  // Chromium has loaded its own by the time we run; Windows tokens are re-encrypted explicitly.
  /^Local State$/,
  /^migrated-from-miac\.json$/,
  /^migrating-from-miac$/,
  /^lockfile$/,
  /^Network$/,
  /^Crashpad/,
  /^BrowserMetrics/,
  /^IndexedDB$/,
  /^WebStorage$/,
  /^Service Worker$/,
  /^shared_proto_db$/,
  /^VideoDecodeStats$/,
  /^SharedStorage/,
  /^segmentation_platform$/,
  /^Dictionaries$/,
  /_crx_cache$/,
  /^logs$/,
  /\.tmp$/,
  /\.corrupt-/,
];
export const MARKER = 'migrated-from-miac.json';
/** Present while a copy runs, holding `{ "attempts": N }`; if it is still there at the next start the copy failed and runs again. */
export const SENTINEL = 'migrating-from-miac';
/** After this many failed runs the copy gives up: a marker with `failed: true` stops further runs. */
const MAX_ATTEMPTS = 3;
const DATA = ['state.json', 'connections.json'];
/** Chromium's localStorage; copied best effort, since a running MIAC holds its files locked. */
const LOCAL_STORAGE = 'Local Storage';

export type DataMigration = {
  copied: string[];
  connections: boolean;
  /** Set when the copy gave up after MAX_ATTEMPTS failed runs. */
  failed?: true;
};

export type Copy = (
  src: string,
  dest: string,
  filter?: (src: string) => boolean,
) => Promise<void>;

async function readAttempts(file: string): Promise<number> {
  try {
    const n = (
      JSON.parse(await fs.readFile(file, 'utf8')) as { attempts?: unknown }
    ).attempts;
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** First start of Shellie on a machine that ran MIAC: copy the app's files from the old `miac` folder. The old folder is left as it is. */
export async function migrateDataFolder(opts: {
  from: string;
  to: string;
  platform: NodeJS.Platform;
  copy?: Copy;
}): Promise<DataMigration | null> {
  const copy: Copy =
    opts.copy ??
    ((s, d, filter) =>
      fs.cp(s, d, {
        recursive: true,
        errorOnExist: false,
        force: true,
        filter,
      }));
  if (await pathExists(path.join(opts.to, MARKER))) return null;
  const sentinel = path.join(opts.to, SENTINEL);
  const interrupted = await pathExists(sentinel);
  if (!interrupted)
    for (const f of DATA)
      if (await pathExists(path.join(opts.to, f))) return null;
  const hasData = await Promise.all(
    DATA.map((f) => pathExists(path.join(opts.from, f))),
  );
  if (!hasData.some(Boolean)) return null;

  const names = (await fs.readdir(opts.from)).filter(
    (n) => !CHROMIUM.some((r) => r.test(n)),
  );
  await fs.mkdir(opts.to, { recursive: true });
  const attempts = (interrupted ? await readAttempts(sentinel) : 0) + 1;
  await fs.writeFile(sentinel, JSON.stringify({ attempts }));
  // Data files last: all copied to a temp name first, then renamed back to back, so a failure leaves no state.json.
  const ordered = [
    ...names.filter((n) => !DATA.includes(n)),
    ...names.filter((n) => DATA.includes(n)),
  ];
  const data = ordered.filter((n) => DATA.includes(n));
  const copied: string[] = [];
  try {
    for (const n of ordered) {
      const dest = path.join(opts.to, n);
      if (DATA.includes(n)) {
        await fs.rm(`${dest}.migrating`, { force: true });
        await copy(path.join(opts.from, n), `${dest}.migrating`);
      } else if (n === LOCAL_STORAGE) {
        try {
          await fs.rm(dest, { recursive: true, force: true });
          await copy(
            path.join(opts.from, n),
            dest,
            (src) => path.basename(src) !== 'LOCK',
          );
          copied.push(n);
        } catch {
          // Best effort: the prefs it holds are copied again by the renderer from what is there.
        }
      } else {
        await fs.rm(dest, { recursive: true, force: true });
        await copy(path.join(opts.from, n), dest);
        copied.push(n);
      }
    }
    for (const n of data) {
      await renameWithRetry(
        path.join(opts.to, `${n}.migrating`),
        path.join(opts.to, n),
      );
      copied.push(n);
    }
  } catch (err) {
    if (attempts < MAX_ATTEMPTS) throw err;
    // Give up: boot runs unmigrated from now on.
    for (const n of data)
      await fs.rm(path.join(opts.to, `${n}.migrating`), { force: true });
    const failed: DataMigration = {
      copied,
      connections: false,
      failed: true,
    };
    await fs.writeFile(
      path.join(opts.to, MARKER),
      JSON.stringify(
        { at: new Date().toISOString(), failed: true, attempts, copied },
        null,
        2,
      ),
    );
    await fs.rm(sentinel, { force: true });
    return failed;
  }
  const result: DataMigration = {
    copied,
    connections: copied.includes('connections.json'),
  };
  await fs.writeFile(
    path.join(opts.to, MARKER),
    JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2),
  );
  await fs.rm(sentinel, { force: true });
  return result;
}
