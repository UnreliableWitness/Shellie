import fs from 'node:fs/promises';
import path from 'node:path';

export type WriteHit = { path: string; via: 'edit' | 'worktree-add' | 'git' };

const EDIT_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

const WRITING_GIT = new Set([
  'commit',
  'checkout',
  'switch',
  'add',
  'apply',
  'stash',
  'merge',
  'rebase',
  'cherry-pick',
]);

/** git global options that take a separate value (besides -C, handled on its own). */
const GIT_VALUE_OPTIONS = new Set([
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
]);

/** Splits a command into segments of words at `&&`, `||`, `;` and `|` outside quotes. */
function tokenize(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;

  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (
        c === '\\' &&
        i + 1 < command.length &&
        '"\\$`'.includes(command[i + 1])
      ) {
        word += command[++i];
      } else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < command.length) {
      // On Windows a backslash is usually a path separator, so keep it there.
      if (path.sep === '\\') word += c;
      else word += command[++i];
      inWord = true;
    } else if (c === '&' && command[i + 1] === '&') {
      i++;
      endSegment();
    } else if (c === '|' && command[i + 1] === '|') {
      i++;
      endSegment();
    } else if (c === ';' || c === '|' || c === '\n') {
      endSegment();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) return []; // unterminated quote: do not guess
  endSegment();
  return segments;
}

/** `p` resolved against `dir`; a relative path with no known dir is null (never guessed from Shellie's own cwd). */
function resolveIn(dir: string | null, p: string): string | null {
  if (path.isAbsolute(p)) return path.resolve(p);
  return dir === null ? null : path.resolve(dir, p);
}

function gitHit(words: string[], cwd: string | null): WriteHit | null {
  let dir = cwd;
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    if (w === '-C') {
      if (i + 1 >= words.length) return null;
      dir = resolveIn(dir, words[i + 1]);
      i += 2;
    } else if (GIT_VALUE_OPTIONS.has(w)) {
      i += 2;
    } else {
      i += 1;
    }
  }
  const sub = words[i];
  if (!sub) return null;
  if (sub === 'worktree') {
    if (words[i + 1] !== 'add') return null;
    for (let j = i + 2; j < words.length; j++) {
      const w = words[j];
      if (w === '-b' || w === '-B') j++;
      else if (!w.startsWith('-')) {
        const p = resolveIn(dir, w);
        return p === null ? null : { path: p, via: 'worktree-add' };
      }
    }
    return null;
  }
  return WRITING_GIT.has(sub) && dir !== null
    ? { path: dir, via: 'git' }
    : null;
}

/** Tokenises one Bash command and returns the writes it makes (worktree add, writing git commands). A null cwd keeps only absolute paths. */
export function writeHitsFromBash(
  command: string,
  cwd: string | null,
): WriteHit[] {
  const hits: WriteHit[] = [];
  let dir = cwd ? path.resolve(cwd) : null;
  for (const words of tokenize(command)) {
    if (words[0] === 'cd' && words[1] && !words[1].startsWith('-')) {
      dir = resolveIn(dir, words[1]);
    } else if (words[0] === 'git') {
      const hit = gitHit(words, dir);
      if (hit) hits.push(hit);
    }
  }
  return hits;
}

/** Parses Claude Code JSONL lines; only assistant tool_use blocks count. */
export function writeHitsFromLines(lines: string[]): WriteHit[] {
  const hits: WriteHit[] = [];
  for (const line of lines) {
    if (!line.includes('"tool_use"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content))
      continue;
    const cwd = typeof entry.cwd === 'string' && entry.cwd ? entry.cwd : null;
    for (const block of entry.message.content) {
      if (
        block?.type !== 'tool_use' ||
        typeof block.input !== 'object' ||
        !block.input
      )
        continue;
      const key = EDIT_TOOLS[block.name];
      if (key) {
        const p = block.input[key];
        const resolved = typeof p === 'string' && p ? resolveIn(cwd, p) : null;
        if (resolved) hits.push({ path: resolved, via: 'edit' });
      } else if (
        block.name === 'Bash' &&
        typeof block.input.command === 'string'
      ) {
        hits.push(...writeHitsFromBash(block.input.command, cwd));
      }
    }
  }
  return hits;
}

/** OpenCode's tools that write one file, and the input key naming it. */
const OPENCODE_EDIT_TOOLS: Record<string, string> = {
  edit: 'filePath',
  write: 'filePath',
  multiedit: 'filePath',
};

/** The files a patch (OpenCode's `patch` and `apply_patch`) adds, updates, deletes or moves to. */
function patchFiles(text: string): string[] {
  const files: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/.exec(
      line.replace(/\r$/, ''),
    );
    if (m && m[1].trim()) files.push(m[1].trim());
  }
  return files;
}

/** The writes one OpenCode tool call makes, like `writeHitsFromLines` for Claude; `cwd` is its session's folder. */
export function writeHitsFromOpenCodeTool(
  tool: string,
  input: unknown,
  cwd: string | null,
): WriteHit[] {
  if (typeof input !== 'object' || !input) return [];
  const i = input as Record<string, unknown>;
  const key = OPENCODE_EDIT_TOOLS[tool];
  if (key) {
    const p = i[key];
    const resolved = typeof p === 'string' && p ? resolveIn(cwd, p) : null;
    return resolved ? [{ path: resolved, via: 'edit' }] : [];
  }
  if (
    (tool === 'patch' || tool === 'apply_patch') &&
    typeof i.patchText === 'string'
  )
    return patchFiles(i.patchText).flatMap((p) => {
      const resolved = resolveIn(cwd, p);
      return resolved ? [{ path: resolved, via: 'edit' as const }] : [];
    });
  if (tool === 'bash' && typeof i.command === 'string') {
    // `workdir` is where OpenCode runs the command when given.
    const dir =
      typeof i.workdir === 'string' && i.workdir
        ? resolveIn(cwd, i.workdir)
        : cwd;
    return writeHitsFromBash(i.command, dir);
  }
  return [];
}

/** `skipped`: bytes consumed without text (part of a line longer than the read cap). */
export type ReadChunk = (
  file: string,
  from: number,
) => Promise<{ text: string; size: number; skipped?: number } | null>;

/** At most this much of a log is read per call; Claude Code logs can grow to hundreds of MB. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * Reads from `from` to the end (at most `cap` bytes), cut after the last newline so no multibyte character is
 * split. A capped read without any newline is one huge line: it is skipped, not kept in memory.
 */
export const readFromDisk =
  (cap: number = MAX_READ_BYTES): ReadChunk =>
  async (file, from) => {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const { size } = await handle.stat();
      if (from >= size) return { text: '', size };
      const buf = Buffer.alloc(Math.min(size - from, cap));
      const { bytesRead } = await handle.read(buf, 0, buf.length, from);
      const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (end < 0 && bytesRead === cap)
        return { text: '', size, skipped: bytesRead };
      return {
        text: end < 0 ? '' : buf.subarray(0, end + 1).toString('utf8'),
        size,
      };
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  };

/** Reads only what was appended since the last call per file. */
export class SessionLogReader {
  private state = new Map<
    string,
    { offset: number; partial: string; size: number; dropFirst: boolean }
  >();

  constructor(private readChunk: ReadChunk = readFromDisk()) {}

  /** True when the last read stopped at the cap with more of the file left. */
  behind(file: string): boolean {
    const st = this.state.get(file);
    return !!st && st.offset < st.size;
  }

  async readNew(file: string): Promise<string[]> {
    const fresh = { offset: 0, partial: '', size: 0, dropFirst: false };
    let st = this.state.get(file) ?? fresh;
    let chunk = await this.readChunk(file, st.offset);
    if (!chunk) return [];
    if (chunk.size < st.offset) {
      st = fresh;
      chunk = await this.readChunk(file, 0);
      if (!chunk) return [];
    }
    if (chunk.skipped) {
      // The middle of a line too long to keep: drop it, and its end when the next newline comes.
      this.state.set(file, {
        offset: st.offset + chunk.skipped,
        partial: '',
        size: chunk.size,
        dropFirst: true,
      });
      return [];
    }
    const text = st.partial + chunk.text;
    const parts = text.split('\n');
    const partial = parts.pop() ?? '';
    let dropFirst = st.dropFirst;
    if (dropFirst && chunk.text.length > 0) {
      parts.shift();
      dropFirst = false;
    }
    this.state.set(file, {
      offset: st.offset + Buffer.byteLength(chunk.text),
      partial,
      size: chunk.size,
      dropFirst,
    });
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  }
}
