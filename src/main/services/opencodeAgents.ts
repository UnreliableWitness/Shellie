import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { errorMessage } from '../../shared/errors';

/** Where OpenCode reads project agents; APM deploys there for `--target opencode`. */
const AGENT_DIRS = ['.opencode/agents', '.opencode/agent'];

/** Claude Code's built-in tool names and OpenCode's names for them. */
const BUILTINS: Record<string, string> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  glob: 'glob',
  grep: 'grep',
  ls: 'list',
  bash: 'bash',
  webfetch: 'webfetch',
  websearch: 'websearch',
  todowrite: 'todowrite',
  todoread: 'todoread',
  task: 'task',
};

/**
 * OpenCode's name for a Claude Code tool: built-ins lowercased, `mcp__server__tool` as `server_tool`, and a
 * permission pattern such as `Bash(git:*)` as its tool. `known` is false for a name it only lowercased.
 */
function openCodeTool(name: string): { name: string; known: boolean } {
  const bare = name.replace(/\(.*\)$/, '').trim();
  const mcp = /^mcp__(.+?)__(.+)$/.exec(bare);
  if (mcp) return { name: `${mcp[1]}_${mcp[2]}`, known: true };
  const builtin = BUILTINS[bare.toLowerCase()];
  return builtin
    ? { name: builtin, known: true }
    : { name: bare.toLowerCase(), known: false };
}

const yamlKey = (k: string) => (/^[\w.-]+$/.test(k) ? k : JSON.stringify(k));

/**
 * The agent file with Claude Code's `tools: Read, Grep` (a string or list) as OpenCode's map, and a `model:` that
 * is not a provider/model id dropped. Undefined when nothing needs to change or the frontmatter cannot be read.
 */
export function convertAgentFile(
  text: string,
  log: (l: string) => void = () => {},
): string | undefined {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return undefined;
  let front: unknown;
  try {
    front = parseYaml(lines.slice(1, end).join('\n'));
  } catch {
    return undefined;
  }
  if (!front || typeof front !== 'object' || Array.isArray(front))
    return undefined;
  const { tools, model } = front as Record<string, unknown>;

  const names =
    typeof tools === 'string'
      ? tools.split(',')
      : Array.isArray(tools) && tools.every((t) => typeof t === 'string')
        ? (tools as string[])
        : undefined;
  const dropModel = typeof model === 'string' && !model.includes('/');
  if (!names && !dropModel) return undefined;

  const out: string[] = [];
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const key = /^([\w-]+)\s*:/.exec(line)?.[1];
    if (key !== 'tools' && key !== 'model') {
      out.push(line);
      continue;
    }
    if (key === 'model' && !dropModel) {
      out.push(line);
      continue;
    }
    if (key === 'tools' && !names) {
      out.push(line);
      continue;
    }
    // Skip the value's continuation lines (a block list or a folded string).
    while (i + 1 < end && /^(\s|-)/.test(lines[i + 1])) i++;
    if (key === 'model') continue;
    const map = new Map<string, true>();
    for (const raw of names ?? []) {
      if (!raw.trim()) continue;
      const tool = openCodeTool(raw);
      if (!tool.known) log(`kept unknown tool ${raw.trim()} as ${tool.name}`);
      map.set(tool.name, true);
    }
    out.push('tools:', ...[...map.keys()].map((k) => `  ${yamlKey(k)}: true`));
  }
  return [lines[0], ...out, ...lines.slice(end)].join(eol);
}

/**
 * APM copies Claude Code agent files to `.opencode/agents/` as they are, and OpenCode will not start on their
 * `tools: Read, Grep` (#318). Rewrites them in the worktree; a file it cannot convert is logged and left.
 */
export async function normalizeOpenCodeAgents(
  worktree: string,
  log: (l: string) => void,
): Promise<string[]> {
  const converted: string[] = [];
  for (const dir of AGENT_DIRS) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(worktree, dir));
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
      const rel = `${dir}/${name}`;
      const file = path.join(worktree, dir, name);
      try {
        const st = await fs.lstat(file);
        if (!st.isFile()) continue;
        const text = await fs.readFile(file, 'utf8');
        const next = convertAgentFile(text, (l) => log(`${rel}: ${l}`));
        if (next === undefined) continue;
        await fs.writeFile(file, next);
        log(`converted ${rel} to OpenCode's agent format`);
        converted.push(rel);
      } catch (e) {
        log(`could not convert ${rel}: ${errorMessage(e)}`);
      }
    }
  }
  return converted;
}
