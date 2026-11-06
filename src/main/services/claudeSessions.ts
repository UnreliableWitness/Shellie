import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code's config folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

/** Where Claude Code keeps its sessions: `<config dir>/projects/<folder per cwd>/<session id>.jsonl`. */
export function claudeProjectsDir(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  return path.join(claudeConfigDir(env, home), 'projects');
}

/** Claude Code's folder for a cwd: every character that is not a letter or digit becomes "-". */
export function claudeProjectFolder(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Whether Claude Code saved any conversation in this folder (tasks from before session ids). */
export function claudeHasSessionsIn(
  cwd: string,
  projectsDir: string = claudeProjectsDir(),
): boolean {
  try {
    return readdirSync(path.join(projectsDir, claudeProjectFolder(cwd))).some(
      (f) => f.endsWith('.jsonl'),
    );
  } catch {
    return false;
  }
}

/**
 * Whether Claude Code saved a conversation with this id. A session is only written once the user sends a
 * message, so a tab started with --session-id but never used has none and must start again, not resume.
 * Any folder under projects/ is checked, so the way Claude names the folder for a cwd does not matter.
 */
export function claudeSessionExists(
  sessionId: string,
  projectsDir: string = claudeProjectsDir(),
): boolean {
  return claudeSessionFile(sessionId, projectsDir) !== null;
}

/** The transcript of a session id in any folder under projects/, or null when Claude Code saved none. */
export function claudeSessionFile(
  sessionId: string,
  projectsDir: string = claudeProjectsDir(),
): string | null {
  let folders: string[];
  try {
    folders = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const f of folders) {
    const file = path.join(projectsDir, f, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}
