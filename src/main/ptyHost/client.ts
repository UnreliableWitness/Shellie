import type { Command } from '../platform/Platform';
import { ExitError, type runWithInput } from '../services/prSummary';
import type { FromHost, ToHost } from './protocol';

/** A started host: takes messages; its own messages and its exit go to the callbacks given to the starter. */
export type HostChannel = { post(m: ToHost): void };
export type HostStarter = (on: {
  message(m: FromHost): void;
  exit(): void;
}) => HostChannel;

export type PtyOptions = {
  file: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
};

/** A pty in the host, as TerminalManager holds it. */
export type PtyProcess = {
  /** The process id, once the host started it. */
  pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Kills a running process; an exited one is forgotten. */
  kill(): void;
};

export type PtyListeners = {
  data(data: string): void;
  /** `exitCode` is what node-pty reported (undefined when the host went away). */
  exit(exitCode: unknown): void;
};

/** What TerminalManager needs from the host. */
export interface PtyHost {
  /** `started` rejects with node-pty's error when the process could not be started; no exit follows then. */
  spawn(
    o: PtyOptions,
    on: PtyListeners,
  ): { proc: PtyProcess; started: Promise<void> };
}

type Pty = {
  on: PtyListeners;
  started: { resolve(): void; reject(e: Error): void };
  proc: PtyProcess;
  /** The host answered the spawn. */
  spawned: boolean;
  exited: boolean;
  forgotten: boolean;
};

type Run = { resolve(stdout: string): void; reject(e: Error): void };

/**
 * Main's side of the pty host (#271): starts the host on first use, relays spawns and runs to it, and routes its
 * messages back. When the host goes away, every pty it held exits (code unknown), every pending run fails, and the
 * next spawn or run starts a new host.
 */
export class PtyHostClient implements PtyHost {
  private channel: HostChannel | null = null;
  private next = 1;
  private readonly ptys = new Map<number, Pty>();
  private readonly runs = new Map<number, Run>();

  constructor(private readonly start: HostStarter) {}

  spawn(
    o: PtyOptions,
    on: PtyListeners,
  ): { proc: PtyProcess; started: Promise<void> } {
    const n = this.next++;
    let started!: Pty['started'];
    const startedPromise = new Promise<void>((resolve, reject) => {
      started = { resolve, reject };
    });
    const proc: PtyProcess = {
      write: (data) => this.send({ t: 'write', n, data }),
      resize: (cols, rows) => this.send({ t: 'resize', n, cols, rows }),
      kill: () => {
        const p = this.ptys.get(n);
        if (!p) return;
        if (p.exited) this.ptys.delete(n);
        else {
          // Kept until its exit arrives, which settles the caller's wait.
          p.forgotten = true;
          this.send({ t: 'kill', n });
        }
      },
    };
    this.ptys.set(n, {
      on,
      started,
      proc,
      spawned: false,
      exited: false,
      forgotten: false,
    });
    this.host().post({ t: 'spawn', n, ...o });
    return { proc, started: startedPromise };
  }

  /** runWithInput, run by the host: same result, same errors (ExitError for a non-zero exit, `code` kept). */
  run(
    { command, args, env }: Command,
    o: Parameters<typeof runWithInput>[1],
  ): Promise<string> {
    const n = this.next++;
    return new Promise<string>((resolve, reject) => {
      this.runs.set(n, { resolve, reject });
      this.host().post({
        t: 'run',
        n,
        command,
        args,
        cwd: o.cwd,
        input: o.input,
        timeoutMs: o.timeoutMs,
        env: definedEnv({ ...process.env, ...o.env, ...env }),
      });
    });
  }

  private host(): HostChannel {
    if (this.channel) return this.channel;
    // Callbacks of a host that was replaced (or disposed) are ignored.
    let channel: HostChannel | null = null;
    channel = this.start({
      message: (m) => {
        if (this.channel === channel) this.receive(m);
      },
      exit: () => {
        if (this.channel === channel) this.gone();
      },
    });
    this.channel = channel;
    return channel;
  }

  /** Messages for a pty or run the host no longer has are dropped; a dead host is not started for them. */
  private send(m: ToHost): void {
    if (this.channel && this.ptys.has(m.n)) this.channel.post(m);
  }

  private receive(m: FromHost): void {
    if (m.t === 'ran' || m.t === 'runError') {
      const r = this.runs.get(m.n);
      if (!r) return;
      this.runs.delete(m.n);
      if (m.t === 'ran') return r.resolve(m.stdout);
      const e = m.exit
        ? new ExitError(m.message, m.exit.exitCode, m.exit.stdout)
        : new Error(m.message);
      if (m.code) (e as NodeJS.ErrnoException).code = m.code;
      return r.reject(e);
    }
    const p = this.ptys.get(m.n);
    if (!p) return;
    switch (m.t) {
      case 'spawned':
        p.spawned = true;
        p.proc.pid = m.pid;
        return p.started.resolve();
      case 'spawnError':
        this.ptys.delete(m.n);
        return p.started.reject(new Error(m.message));
      case 'data':
        return p.on.data(m.data);
      case 'exit':
        // An exited pty stays until TerminalManager forgets it: output can still arrive after the exit.
        p.exited = true;
        if (p.forgotten) this.ptys.delete(m.n);
        return p.on.exit(m.exitCode);
    }
  }

  /** The host is gone: ends what it held, so the next use starts a new one. */
  private gone(): void {
    this.channel = null;
    const ptys = [...this.ptys.values()];
    const runs = [...this.runs.values()];
    this.ptys.clear();
    this.runs.clear();
    const error = () => new Error('The terminal host stopped');
    for (const r of runs) r.reject(error());
    for (const p of ptys) {
      if (p.exited) continue;
      p.exited = true;
      // A spawn the host never answered did not start; one that did has ended.
      if (!p.spawned) p.started.reject(error());
      else p.on.exit(undefined);
    }
  }
}

/** process.env without its unset names: a structured-clone message holds strings only. */
function definedEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}
