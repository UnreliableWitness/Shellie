import path from 'node:path';

/** The native path of a brain page or source given as a posix-relative path (`notes/a.md`). */
export const absPath = (brainDir: string, rel: string): string =>
  path.join(brainDir, ...rel.split('/').filter(Boolean));
