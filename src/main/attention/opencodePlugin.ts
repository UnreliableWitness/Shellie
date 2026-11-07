import path from 'node:path';
import { opencodePermission } from '../secrets/deny';

/**
 * The OpenCode plugin Shellie writes to `<userData>/opencode/shellie-attention.js` and loads through
 * OPENCODE_CONFIG_CONTENT. It reports when the main session waits on the developer. Plain JS, no imports: OpenCode
 * (Bun) loads it as is. OpenCode rejects modules with exports other than plugin functions, so it exports one.
 */
export const OPENCODE_PLUGIN_SOURCE = `// Written by Shellie on every start; edits are overwritten.
export const ShellieAttention = async () => {
  const url = process.env.SHELLIE_ATTENTION_URL;
  const token = process.env.SHELLIE_ATTENTION_TOKEN;
  const terminalId = process.env.SHELLIE_TERMINAL_ID;
  if (!url || !token || !terminalId) return {};
  const children = new Set();
  let last = '';
  const send = (state, kind, message) => {
    const key = state + '|' + (kind || '') + '|' + (message || '');
    if (key === last) return;
    last = key;
    const body = { terminalId, state };
    if (kind) body.kind = kind;
    if (message) body.message = String(message).slice(0, 2000);
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shellie-token': token },
      body: JSON.stringify(body),
    }).catch(() => {});
  };
  return {
    event: async ({ event }) => {
      try {
        const p = event.properties || {};
        if (event.type === 'session.created' || event.type === 'session.updated') {
          if (p.info && p.info.parentID) children.add(p.info.id || p.sessionID);
          return;
        }
        const child = p.sessionID && children.has(p.sessionID);
        // A subagent's prompt blocks the run, but its status, idle and error events would give a false done.
        if (child && !/^(permission|question)\./.test(event.type)) return;
        switch (event.type) {
          case 'permission.asked':
            return send('blocked', 'permission', [p.permission, (p.patterns || []).join(' ')].filter(Boolean).join(': '));
          case 'question.asked':
            return send('blocked', 'question');
          case 'permission.replied':
          case 'question.replied':
          case 'question.rejected':
            return send('working');
          case 'session.status':
            if (!p.status) return;
            return send(p.status.type === 'idle' ? 'done' : 'working');
          case 'session.idle':
            return send('done');
          case 'session.error':
            return send('done', 'error', p.error && (p.error.name || p.error.message));
        }
      } catch {}
    },
  };
};
`;

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** A permission entry as a pattern map: a plain action ("allow") becomes `{"*": "allow"}`. */
const patterns = (v: unknown): Record<string, unknown> =>
  isObject(v) ? v : typeof v === 'string' ? { '*': v } : {};

/** `permission` with the deny entries for the secret files added to `read` and `bash`. */
function withDeny(own: Record<string, unknown>, paths: string[]) {
  const deny = opencodePermission(paths);
  return {
    ...own,
    read: { ...patterns(own.read), ...deny.read },
    bash: { ...patterns(own.bash), ...deny.bash },
  };
}

/** `rules` with `pattern` set to `action` as its last entry (OpenCode's last matching rule wins). */
const last = (rules: unknown, pattern: string, action: string) => {
  const { [pattern]: _, ...rest } = patterns(rules);
  return { ...rest, [pattern]: action };
};

/** A Windows absolute path (`C:\…`, `\\server\…`) is read with win32 rules on any platform, so tests can use one. */
const pathFor = (p: string) =>
  /^([A-Za-z]:[\\/]|\\\\)/.test(p) ? path.win32 : path.posix;

/** OpenCode globs take forward slashes: a backslash is an escape to it, not a separator. */
const slashes = (p: string) => p.replace(/\\/g, '/');

/**
 * `permission` with the brain folder readable from outside the project and not editable, after the developer's own
 * rules. OpenCode matches `edit` rules against the path from the tab's folder (an absolute pattern never matched,
 * checked live with 1.19.3), so the deny names the brain from each of `worktrees`, and by its absolute path as well
 * (a brain on another drive, a later OpenCode). Every glob uses forward slashes. A worktree inside the brain gets no
 * edit deny at all: any glob for the brain would cover the worktree's own files.
 */
function withBrain(
  permission: Record<string, unknown>,
  brainDir: string,
  worktrees: readonly string[],
) {
  const p = pathFor(brainDir);
  const glob = `${slashes(brainDir).replace(/\/+$/, '')}/**`;
  const inBrain = worktrees.some((w) => {
    const r = p.relative(brainDir, w);
    return r === '' || (!r.startsWith('..') && !p.isAbsolute(r));
  });
  const editGlobs = inBrain
    ? []
    : [
        ...new Set([
          ...worktrees.map((w) => `${slashes(p.relative(w, brainDir))}/**`),
          glob,
        ]),
      ];
  return {
    ...permission,
    external_directory: last(permission.external_directory, glob, 'allow'),
    ...(editGlobs.length
      ? {
          edit: editGlobs.reduce<unknown>(
            (rules, g) => last(rules, g, 'deny'),
            permission.edit,
          ),
        }
      : {}),
  };
}

/**
 * OPENCODE_CONFIG_CONTENT with Shellie's plugin added, and `instructions` (a file with the `shellie run` line)
 * when given, and `permission` deny entries for `denyPaths` (untracked secret files), and read-only access to
 * `brainDir` (the task's brain folder, from the tab's folder `worktrees`, as given and real); undefined when the
 * developer's own value is not a JSON object.
 */
export function opencodeConfigContent(
  existing: string | undefined,
  pluginPath: string | null,
  instructions?: string,
  denyPaths: string[] = [],
  brainDir?: string,
  worktrees: readonly string[] = [],
): string | undefined {
  // The developer's own `permission`; a plain action ("allow") applies to every tool.
  const permission = (given: unknown) => {
    const own = isObject(given)
      ? given
      : typeof given === 'string'
        ? { '*': given }
        : {};
    const denied = denyPaths.length > 0 ? withDeny(own, denyPaths) : own;
    return brainDir ? withBrain(denied, brainDir, worktrees) : denied;
  };
  const extra = (config: { instructions?: unknown; permission?: unknown }) => ({
    ...(instructions
      ? {
          instructions: [
            ...(Array.isArray(config.instructions) ? config.instructions : []),
            instructions,
          ],
        }
      : {}),
    ...(denyPaths.length > 0 || brainDir
      ? { permission: permission(config.permission) }
      : {}),
  });
  // No plugin and nothing else to add: the developer's own value (if any) is left alone.
  const nothing =
    !pluginPath && !instructions && denyPaths.length === 0 && !brainDir;
  if (nothing) return undefined;
  const plugin = (list: unknown[]) =>
    pluginPath ? { plugin: [...list, pluginPath] } : {};
  if (!existing) return JSON.stringify({ ...plugin([]), ...extra({}) });
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return undefined;
  const config = parsed as {
    plugin?: unknown;
    instructions?: unknown;
    permission?: unknown;
  };
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  return JSON.stringify({
    ...config,
    ...plugin(plugins),
    ...extra(config),
  });
}

/** What a tab loses when the developer's OPENCODE_CONFIG_CONTENT is not a JSON object, for the warning. */
export function lostConfig(denied: number, brain: boolean): string {
  const lost = [
    ...(denied > 0
      ? [`${denied} secret file ${denied === 1 ? 'deny' : 'denies'}`]
      : []),
    ...(brain ? ["the brain folder's read access and edit deny"] : []),
  ];
  return `not applied: ${lost.length ? lost.join(', ') : 'the attention plugin'}`;
}
