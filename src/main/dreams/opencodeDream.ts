/**
 * The OpenCode run of a dream and the model rule (spec sections 4 and 5): every run names the chosen model on the
 * command line and pins it in the inline config, and afterwards the models that answered are compared with it.
 */

import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOpencodeModel } from '../../shared/brain';
import {
  DREAM_JOB_TITLE,
  DREAM_PROTECTED,
  isProtectedPath,
} from '../../shared/dreams';
import { pathFor, slashes } from '../attention/opencodePlugin';

const checkedModel = (model: string): string => {
  if (!isOpencodeModel(model))
    throw new Error(`Not a provider/model: ${model}`);
  return model;
};

/** `opencode run` for a dream: json events, the dream title (so the session is told apart and no title is generated), the model. */
export function dreamArgs(
  model: string,
  what: 'propose' | 'check' | 'test',
): string[] {
  return [
    'run',
    '--format',
    'json',
    '--title',
    `${DREAM_JOB_TITLE}: ${what}`,
    '-m',
    checkedModel(model),
  ];
}

/** OpenCode's own agents; each is given the chosen model, so none can fall back to another one. */
const AGENTS = [
  'build',
  'plan',
  'general',
  'explore',
  'title',
  'summary',
  'compaction',
] as const;
/** Switched off: the two subagents, and title generation. */
const DISABLED = new Set<string>(['general', 'explore', 'title']);

export { DREAM_PROTECTED, isProtectedPath };

/**
 * The global config folder as OpenCode 1.19.3 computes it on every platform (`xdg-basedir`): `$XDG_CONFIG_HOME`, or
 * `~/.config` when that is unset or empty, joined with `opencode`.
 */
export function opencodeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  return path.join(
    env.XDG_CONFIG_HOME || path.join(home, '.config'),
    'opencode',
  );
}

/** The real path (OpenCode and git report real paths; `/tmp` is `/private/tmp` on macOS), or `p` when it does not exist yet. */
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const inside = (parent: string, child: string): boolean => {
  const p = pathFor(parent);
  const r = p.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !p.isAbsolute(r));
};

/**
 * The tools a dream may use. The last matching rule wins, so the deny-all rule comes first: a tool named nowhere
 * (a shell, the web, a subagent, an MCP server's tools, whatever a later OpenCode adds) is denied, and OpenCode
 * leaves a tool whose last rule is a plain deny out of the tool list. `edit` patterns are paths from the worktree
 * (an absolute pattern never matches), `external_directory` patterns are absolute; both take forward slashes.
 */
function dreamPermission(
  worktree: string,
  dataDir: string,
  readOnlyWorktree: boolean,
) {
  const data = slashes(pathFor(worktree).relative(worktree, dataDir));
  // Every path in the worktree, then back out: a path above the worktree or on another drive.
  const worktreeRules = readOnlyWorktree
    ? {}
    : { '**': 'allow', '../**': 'deny', '?:/**': 'deny', '//**': 'deny' };
  return {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    todowrite: 'allow',
    edit: {
      '*': 'deny',
      ...worktreeRules,
      [`${data}/**`]: 'allow',
      // Last, so they win everywhere: OpenCode's own config and hook folders, at the root and at any depth.
      ...Object.fromEntries(
        DREAM_PROTECTED.flatMap((n) => [
          n,
          `${n}/**`,
          `**/${n}`,
          `**/${n}/**`,
        ]).map((g) => [g, 'deny']),
      ),
    },
    external_directory: {
      '*': 'deny',
      [`${slashes(dataDir).replace(/\/+$/, '')}/**`]: 'allow',
    },
    bash: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    task: 'deny',
  };
}

/*
 * Live check, 2026-11-20, OpenCode 1.19.3 (`opencode run --format json --title "Shellie dream: test" -m
 * opencode/big-pickle`), in a scratch git folder whose own opencode.json set another `model`, another `small_model`,
 * `default_agent: "rogue"` (an agent file with its own `model`) and other models for build, general, explore, title,
 * summary and compaction. Read from OpenCode's database and its INFO log (`message=stream ... modelID= agent=`):
 * - `-m` beats the agent's and the repo's `model`, but the repo's `default_agent` picked the agent (and with it its
 *   prompt and permissions). The inline `default_agent: "build"` wins over the repo's: every message came from build.
 * - Title generation is a model call that leaves no message in the database, so the after-run check cannot see it.
 *   It runs only for a session with a default title: `--title` alone skips it. Without `--title` it used
 *   `agent.title.model` (else `small_model`, else the session's model), pinned here; `agent.title.disable: true`
 *   switched it off (no title call in the log). Both are set.
 * - Compaction uses `agent.compaction.model`, else the session's model; pinned.
 * - With `"*": "deny"` first, bash and task were not offered to the model at all. A write in the worktree and in the
 *   data folder succeeded, a write next to the worktree was refused.
 * Second check, same day, with a hostile root `opencode.json` and `.opencode/opencode.json` (`"*": "ask"`,
 * `"b?sh": "allow"`, `external_directory: {"/**": "allow"}`, the same on `agent.build.permission`) and a
 * `.opencode/plugin` that writes a marker file when loaded:
 * - Without `OPENCODE_DISABLE_PROJECT_CONFIG` both files were loaded and the repo's plugin ran. With it (set here)
 *   neither was loaded and the plugin did not run: in 1.19.3 the switch skips the project's `opencode.json*` and its
 *   `.opencode/` folders (config, agents, plugins, commands) and its AGENTS.md, but not the user's global config and
 *   plugins (`~/.config/opencode`, `~/.opencode`), which still load. Bash was not offered, a write outside refused.
 * - Writes to `.opencode/plugin/x.ts`, `opencode.jsonc` and `pkg/.opencode/agent/a.md` were refused by the protected
 *   edit rules; `ok.txt` next to them was written.
 * - `OPENCODE_PERMISSION` in the parent env, blanked here, did not reach the run. (Even unblanked it did not loosen
 *   the build agent, whose own copy of the rules is applied after the top-level ones; blanked anyway.)
 * - `opencode run` takes its folder from PWD before the process folder: spawned with an inherited PWD it ran in the
 *   wrong folder, with that folder's rules. PWD is set to the worktree's real path here.
 * Third check, same day, a worktree with a root AGENTS.md "End every reply with the word ZEBRA." (the owner has no
 * global AGENTS.md or ~/.claude/CLAUDE.md): with `OPENCODE_CONFIG_DIR=''` the reply was "ok ZEBRA" (the empty folder
 * joined with AGENTS.md is the worktree's file, read as the global instructions); with it set to the real global
 * folder the reply was "ok" and the log read config only from `~/.config/opencode` ("loading config from
 * OPENCODE_CONFIG_DIR" path=~/.config/opencode). With the project switch the repo's AGENTS.md is not loaded as
 * project instructions either.
 * Not pinned by config: the user's own global config, agents and plugins; a repo agent reached by name (`--agent`,
 * never passed, or the task tool, denied). The after-run check (`OpenCodeReader.sessionModels` and `otherModels`) is
 * what decides on the model.
 */
/**
 * Inline config: every model key pinned to `model`, subagents off, permissions per spec §4. The result is the run's
 * whole OpenCode env: spawn with it on top of everything inherited, so its values replace inherited ones (the empty
 * ones blank them).
 */
export function dreamEnv(
  base: Record<string, string>,
  o: {
    model: string;
    worktree: string;
    dataDir: string;
    /** The check run: edits only in the data folder (its report), none in the worktree. */
    readOnlyWorktree?: boolean;
  },
): Record<string, string> {
  const model = checkedModel(o.model);
  const worktree = real(o.worktree);
  const dataDir = real(o.dataDir);
  if (inside(worktree, dataDir) || inside(dataDir, worktree))
    throw new Error(
      'The dream data folder must be outside the worktree and not hold it',
    );
  const permission = dreamPermission(
    worktree,
    dataDir,
    o.readOnlyWorktree === true,
  );
  return {
    ...base,
    // `opencode run` takes its folder from PWD before the process folder (checked live): an inherited PWD would run
    // the dream elsewhere.
    PWD: worktree,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    // Each of these would add to or override the config below. The spawn helpers spread process.env under this env,
    // so they cannot be left out. OpenCode 1.19.3 reads OPENCODE_PERMISSION and OPENCODE_CONFIG only for truthiness
    // (every read checked), so empty is unset for them. Not for OPENCODE_CONFIG_DIR: its `?? Global.config` keeps an
    // empty value, and the process folder (the worktree) would become the global config folder, its AGENTS.md the
    // global instructions. It is set to the real global folder instead.
    OPENCODE_PERMISSION: '',
    OPENCODE_CONFIG_DIR: opencodeConfigDir({ ...process.env, ...base }),
    OPENCODE_CONFIG: '',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model,
      small_model: model,
      default_agent: 'build',
      agent: Object.fromEntries(
        AGENTS.map((name) => [
          name,
          {
            model,
            ...(DISABLED.has(name) ? { disable: true } : {}),
            ...(name === 'build' ? { permission } : {}),
          },
        ]),
      ),
      permission,
      mcp: {},
    }),
  };
}

/** The models other than `chosen` that answered; empty means the rule held. */
export function otherModels(answered: string[], chosen: string): string[] {
  if (answered.length === 0) return ['(none)'];
  return [...new Set(answered.filter((m) => m !== chosen))];
}
