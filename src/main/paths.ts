import path from 'node:path';

/** Worktrees for `/src/webshop` live in `/src/webshop.worktrees/<slug>`. */
export function worktreeRoot(repoPath: string): string {
  const clean = path.resolve(repoPath);
  return path.join(path.dirname(clean), `${path.basename(clean)}.worktrees`);
}

/** Git prints `C:/x/y` on Windows; this gives the native form (`C:\x\y`). A no-op on POSIX. */
export function nativePath(p: string): string {
  return path.resolve(p);
}

/** `abs` relative to `root` with forward slashes, the form git and our configs use on every platform. */
export const toRel = (root: string, abs: string): string =>
  path.relative(root, abs).split(path.sep).join('/');

/** Compares two paths in native form; case-insensitive on Windows. */
export function samePath(a: string, b: string): boolean {
  const x = nativePath(a);
  const y = nativePath(b);
  return process.platform === 'win32'
    ? x.toLowerCase() === y.toLowerCase()
    : x === y;
}

/** True when `target` is `root` or inside it; Windows paths compare case-insensitively. */
export function isInside(
  root: string,
  target: string,
  p: typeof path = path,
): boolean {
  const norm = (x: string) => (p.sep === '\\' ? x.toLowerCase() : x);
  const r = norm(p.resolve(root));
  const t = norm(p.resolve(target));
  if (t === r) return true;
  return t.startsWith(r.endsWith(p.sep) ? r : r + p.sep);
}

/**
 * Dev only: `SHELLIE_USER_DATA=<absolute path>` runs the app on a separate data folder (a fresh profile). A packaged
 * build ignores it, so a stray variable never hides a user's data.
 */
export function userDataOverride(
  env: NodeJS.ProcessEnv,
  packaged: boolean,
): string | null {
  if (packaged) return null;
  const dir = env.SHELLIE_USER_DATA?.trim();
  return dir && path.isAbsolute(dir) ? dir : null;
}
