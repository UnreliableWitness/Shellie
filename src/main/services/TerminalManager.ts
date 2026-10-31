import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import type { ColorScheme } from '../../shared/theme';

export type SpawnOptions = {
  id: string;
  taskId: string;
  cwd: string;
  command: string;
  args: string[];
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /** The output goes through the output filter (agent tabs: leak watch). */
  filtered?: boolean;
};

/**
 * Rewrites a filtered tab's output before it is kept or shown (main: leak watch masks stored values). `carry` is
 * what the last call held back; the returned carry is held until the next chunk, or `final` after a short wait.
 */
export type OutputFilter = (
  o: { id: string; taskId: string },
  data: string,
  carry: string,
  final: boolean,
) => { text: string; carry: string };

type Entry = {
  options: SpawnOptions;
  proc: pty.IPty;
  exited: boolean;
  buffer: string;
  /** The program turned on colour scheme reports (DEC private mode 2031), so a scheme change is pushed to it. */
  schemeReports: boolean;
  /** The last characters of the output, so a mode switch split over two chunks is still seen. */
  tail: string;
  /** Resolves when the process exits, also after the entry was replaced or forgotten. */
  exit: Promise<void>;
  startedAt: number;
  exitedAt?: number;
  /** Output the filter held back (the start of what could be a value split over two chunks). */
  carry: string;
  flushTimer?: NodeJS.Timeout;
};

const BUFFER_LIMIT = 200_000;
/** Longer than any `CSI ? … 2031 h` a program sends, so a split one is caught on the next chunk. */
const TAIL = 64;
/** DEC private mode set (h) or reset (l) with 2031 among its parameters. */
// eslint-disable-next-line no-control-regex -- matching the escape character is the point
const MODE_2031 = /\x1b\[\?(?:\d+;)*2031(?:;\d+)*([hl])/g;

/**
 * Whether colour scheme reports (mode 2031, Contour's dark/light notifications, used by Claude Code) are on after
 * `text`, given whether they were on before: the last set or reset in it wins.
 */
export function schemeReportsAfter(on: boolean, text: string): boolean {
  let last: string | undefined;
  for (const m of text.matchAll(MODE_2031)) last = m[1];
  return last === undefined ? on : last === 'h';
}

/** The report of a scheme change: CSI ? 997 ; 1 n for dark, 2 for light. */
export const schemeReport = (s: ColorScheme): string =>
  `\x1b[?997;${s === 'dark' ? 1 : 2}n`;
/** How long kill waits for the exit before giving up (a process that ignores the kill must not block Finish). */
const KILL_WAIT_MS = 3000;
/** How long a held-back tail waits for the next chunk before it is shown anyway. */
const FLUSH_MS = 50;

/** The exit code reported when the pty closed before the code was known (node-pty with conpty.dll). */
export const UNKNOWN_EXIT = -1;

export const normaliseExitCode = (code: unknown): number =>
  typeof code === 'number' && Number.isFinite(code) ? code : UNKNOWN_EXIT;

/** One pty per terminal id. Exited terminals stay known (for restart and buffer) until killed. */
/**
 * The process environment with `over` on top. Windows reads names regardless of case, so there an `over` name
 * replaces the inherited one in any case (`Path` for `PATH`, `DB` for `Db`): two spellings in one environment block
 * would leave which value a program sees to the order of the block.
 */
export function mergeEnv(
  base: Record<string, string | undefined>,
  over: Record<string, string>,
  ignoreCase: boolean,
): Record<string, string> {
  const env: Record<string, string> = {};
  const lower = new Set(
    ignoreCase ? Object.keys(over).map((k) => k.toLowerCase()) : [],
  );
  for (const [k, v] of Object.entries(base))
    if (v !== undefined && !(ignoreCase && lower.has(k.toLowerCase())))
      env[k] = v;
  return Object.assign(env, over);
}

export class TerminalManager extends EventEmitter<{
  data: [id: string, data: string];
  exit: [id: string, exitCode: number];
}> {
  private readonly entries = new Map<string, Entry>();
  /** The last size the view gave each terminal, kept over kill so a respawn starts at it, not 120x30 (#162). */
  private readonly sizes = new Map<
    string,
    { taskId: string; cols: number; rows: number }
  >();
  private readonly killWaitMs: number;
  private readonly now: () => number;
  private readonly flushMs: number;
  private filter: OutputFilter | null = null;

  constructor(
    o: { killWaitMs?: number; now?: () => number; flushMs?: number } = {},
  ) {
    super();
    this.killWaitMs = o.killWaitMs ?? KILL_WAIT_MS;
    this.now = o.now ?? Date.now;
    this.flushMs = o.flushMs ?? FLUSH_MS;
  }

  /** Sets the filter that filtered tabs' output goes through. */
  setOutputFilter(filter: OutputFilter | null): void {
    this.filter = filter;
  }

  spawn(options: SpawnOptions): void {
    if (this.entries.has(options.id))
      throw new Error(`Terminal ${options.id} already exists`);
    const env = mergeEnv(
      process.env,
      options.env ?? {},
      process.platform === 'win32',
    );
    env.TERM = 'xterm-256color';
    // xterm.js draws 24-bit colour; without this, programs started from the Dock or Start menu (no COLORTERM in
    // the environment) fall back to 256 colours, which bends Claude Code's theme colours (as VS Code sets it).
    env.COLORTERM = 'truecolor';
    env.SHELLIE_TASK_ID = options.taskId;
    env.MIAC_TASK_ID = options.taskId; // for scripts written before the rename
    env.SHELLIE_TERMINAL_ID = options.id;
    const size = this.sizes.get(options.id);
    const proc = pty.spawn(options.command, options.args, {
      name: 'xterm-256color',
      cols: size?.cols ?? options.cols ?? 120,
      rows: size?.rows ?? options.rows ?? 30,
      cwd: options.cwd,
      env,
      // Windows: the bundled conpty.dll. The default (system ConPTY) kill path forks a helper with
      // child_process.fork, which the RunAsNode fuse turns into a second Shellie.exe launch.
      // node-pty is pinned to 1.2.0-beta.15 or later: 1.1.0 has a data race on its Windows pty handle
      // list (microsoft/node-pty#921, fixed in 1.2.0-beta.13) that crashes the process with an access
      // violation when one pty exits while another is spawned, resized or killed.
      ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
    });
    let exitResolve = () => {};
    const exit = new Promise<void>((r) => {
      exitResolve = r;
    });
    const entry: Entry = {
      options,
      proc,
      exited: false,
      buffer: '',
      schemeReports: false,
      tail: '',
      exit,
      startedAt: this.now(),
      carry: '',
    };
    this.entries.set(options.id, entry);
    proc.onData((data) => {
      if (this.entries.get(options.id) !== entry) return;
      const seen = entry.tail + data;
      entry.schemeReports = schemeReportsAfter(entry.schemeReports, seen);
      entry.tail = seen.slice(-TAIL);
      this.deliver(entry, this.filtered(entry, data, false));
    });
    proc.onExit(({ exitCode }) => {
      exitResolve();
      if (this.entries.get(options.id) !== entry) return;
      if (entry.carry) this.deliver(entry, this.filtered(entry, '', true));
      entry.exited = true;
      entry.exitedAt = this.now();
      this.emit('exit', options.id, normaliseExitCode(exitCode));
    });
  }

  /** Keeps and shows output (already filtered). */
  private deliver(entry: Entry, text: string): void {
    if (text === '') return;
    // Trimmed lazily; buffer() returns only the last BUFFER_LIMIT characters.
    entry.buffer += text;
    if (entry.buffer.length > 2 * BUFFER_LIMIT)
      entry.buffer = entry.buffer.slice(-BUFFER_LIMIT);
    this.emit('data', entry.options.id, text);
  }

  /** The chunk as the tab may show it; a held-back tail is shown after flushMs unless more output comes first. */
  private filtered(entry: Entry, data: string, final: boolean): string {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = undefined;
    const { id, taskId } = entry.options;
    if (!entry.options.filtered || !this.filter) {
      const out = entry.carry + data;
      entry.carry = '';
      return out;
    }
    let r: { text: string; carry: string };
    try {
      // After the exit no next chunk comes (a last chunk can arrive after onExit): nothing is held.
      r = this.filter({ id, taskId }, data, entry.carry, final || entry.exited);
    } catch {
      // Never with the output: it may be what the filter was looking for.
      console.error('[terminals] the output filter failed');
      r = { text: entry.carry + data, carry: '' };
    }
    entry.carry = r.carry;
    if (r.carry)
      entry.flushTimer = setTimeout(() => {
        if (this.entries.get(id) === entry && !entry.exited)
          this.deliver(entry, this.filtered(entry, '', true));
      }, this.flushMs);
    return r.text;
  }

  write(id: string, data: string): void {
    const e = this.get(id);
    if (!e.exited) e.proc.write(data);
  }

  /**
   * Tells the program the colour scheme changed, when it asked for that (mode 2031). The renderer calls this after
   * it re-coloured the terminal, so a program that then asks for the background (OSC 11) gets the new one.
   */
  reportScheme(id: string, scheme: ColorScheme): void {
    const e = this.entries.get(id);
    if (e && !e.exited && e.schemeReports) e.proc.write(schemeReport(scheme));
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.get(id);
    const size = {
      taskId: e.options.taskId,
      cols: Math.max(2, Math.floor(cols)),
      rows: Math.max(1, Math.floor(rows)),
    };
    this.sizes.set(id, size);
    if (!e.exited) e.proc.resize(size.cols, size.rows);
  }

  /**
   * Kills and forgets a terminal. Resolves when the process has exited, or after the fallback wait,
   * so a caller can then remove the folder it ran in (Windows refuses while a process has it as cwd).
   * Callers that do not need to wait can ignore the promise.
   */
  kill(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve();
    this.entries.delete(id);
    clearTimeout(e.flushTimer);
    if (e.exited) return Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    const fallback = new Promise<void>((r) => {
      timer = setTimeout(r, this.killWaitMs);
    });
    try {
      e.proc.kill();
    } catch {
      // Already gone; the exit (or the fallback) settles the wait.
    }
    return Promise.race([e.exit, fallback]).finally(() => clearTimeout(timer));
  }

  restart(id: string): void {
    const old = this.get(id);
    void this.kill(id);
    try {
      this.spawn(old.options);
    } catch (error) {
      // Keep the terminal known (and its scrollback readable) when the respawn fails.
      old.exited = true;
      this.entries.set(id, old);
      throw error;
    }
  }

  /** Kills every terminal of a task. Resolves when they have all exited (see kill). */
  async killAllForTask(taskId: string): Promise<void> {
    const ids = [...this.entries]
      .filter(([, e]) => e.options.taskId === taskId)
      .map(([id]) => id);
    for (const [id, size] of this.sizes)
      if (size.taskId === taskId) this.sizes.delete(id);
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  runningCount(taskId: string): number {
    let n = 0;
    for (const e of this.entries.values())
      if (e.options.taskId === taskId && !e.exited) n++;
    return n;
  }

  isRunning(id: string): boolean {
    const e = this.entries.get(id);
    return Boolean(e && !e.exited);
  }

  /** How long the terminal's process ran: until its exit, or until now while it runs; 0 for an unknown one. */
  runMs(id: string): number {
    const e = this.entries.get(id);
    return e ? (e.exitedAt ?? this.now()) - e.startedAt : 0;
  }

  /** The terminal's recent output; null for one this process does not know (the app relaunched, #180). */
  buffer(id: string): string | null {
    const e = this.entries.get(id);
    return e ? e.buffer.slice(-BUFFER_LIMIT) : null;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  private get(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Unknown terminal ${id}`);
    return e;
  }
}
