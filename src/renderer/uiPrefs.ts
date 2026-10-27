export type UiPrefs = { navCollapsed: boolean; focus: boolean };
const KEY: Record<keyof UiPrefs, string> = {
  navCollapsed: 'shellie.ui.navCollapsed',
  focus: 'shellie.ui.focus',
};
const local = (): Storage | undefined =>
  typeof localStorage === 'undefined' ? undefined : localStorage;

/** A stored true/false; false when absent or unreadable. */
export const readFlag = (
  key: string,
  storage: Storage | undefined,
): boolean => {
  try {
    return storage?.getItem(key) === 'true';
  } catch {
    return false;
  }
};

export const writeFlag = (
  key: string,
  value: boolean,
  storage: Storage | undefined,
): void => {
  try {
    storage?.setItem(key, String(value));
  } catch {
    /* preferences are best effort */
  }
};

export function readPrefs(storage: Storage | undefined = local()): UiPrefs {
  return {
    navCollapsed: readFlag(KEY.navCollapsed, storage),
    focus: readFlag(KEY.focus, storage),
  };
}

export function writePref<K extends keyof UiPrefs>(
  key: K,
  value: UiPrefs[K],
  storage: Storage | undefined = local(),
): void {
  writeFlag(KEY[key], value, storage);
}

const NAV_WIDTH_KEY = 'shellie.ui.navWidth';
export const NAV_WIDTH = { min: 160, max: 480, default: 240 };

/** A whole pixel width inside the nav's range; the default for anything not a number. */
export const clampNavWidth = (px: number): number =>
  Number.isFinite(px)
    ? Math.min(NAV_WIDTH.max, Math.max(NAV_WIDTH.min, Math.round(px)))
    : NAV_WIDTH.default;

/** The left nav's stored width (#160); 240 when absent or unreadable. */
export function readNavWidth(storage: Storage | undefined = local()): number {
  try {
    const raw = storage?.getItem(NAV_WIDTH_KEY);
    return raw ? clampNavWidth(Number(raw)) : NAV_WIDTH.default;
  } catch {
    return NAV_WIDTH.default;
  }
}

export function writeNavWidth(
  px: number,
  storage: Storage | undefined = local(),
): void {
  try {
    storage?.setItem(NAV_WIDTH_KEY, String(clampNavWidth(px)));
  } catch {
    /* preferences are best effort */
  }
}

const prKey = (repoId: string) => `shellie.ui.pr.${repoId}`;
const pushKey = (repoId: string) => `shellie.ui.push.${repoId}`;

/** Whether the last Finish of this repo asked for a pull request; false until then. */
export function readPrChoice(
  repoId: string,
  storage: Storage | undefined = local(),
): boolean {
  return readFlag(prKey(repoId), storage);
}

export function writePrChoice(
  repoId: string,
  value: boolean,
  storage: Storage | undefined = local(),
): void {
  writeFlag(prKey(repoId), value, storage);
}

/** Whether the last Finish of this repo (without pull requests) pushed its branch; false until then. */
export function readPushChoice(
  repoId: string,
  storage: Storage | undefined = local(),
): boolean {
  return readFlag(pushKey(repoId), storage);
}

export function writePushChoice(
  repoId: string,
  value: boolean,
  storage: Storage | undefined = local(),
): void {
  writeFlag(pushKey(repoId), value, storage);
}
