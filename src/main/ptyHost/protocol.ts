/**
 * The messages between main and the pty host (a utility process that starts terminals and headless jobs, #271).
 * On Windows, ConPTY's connect and libuv's spawn both call CreateProcessW synchronously, which can take over a second
 * (on-access scanning of a large executable); in the host that blocks the host, not main.
 * `n` numbers one spawn or run: a terminal id is reused by a restart while the old process may still be exiting.
 */
export type ToHost =
  | {
      t: 'spawn';
      n: number;
      file: string;
      args: string[];
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    }
  | { t: 'write'; n: number; data: string }
  | { t: 'resize'; n: number; cols: number; rows: number }
  | { t: 'kill'; n: number }
  | {
      t: 'run';
      n: number;
      command: string;
      args: string[];
      cwd: string;
      input: string;
      timeoutMs: number;
      /** The whole environment, as main built it. */
      env: Record<string, string>;
    };

export type FromHost =
  | { t: 'spawned'; n: number; pid: number }
  | { t: 'spawnError'; n: number; message: string }
  | { t: 'data'; n: number; data: string }
  | { t: 'exit'; n: number; exitCode: unknown }
  | { t: 'ran'; n: number; stdout: string }
  | {
      t: 'runError';
      n: number;
      message: string;
      /** The error's code (ENOENT for a program that is not there). */
      code?: string;
      /** Set for a run that exited non-zero (an ExitError). */
      exit?: { exitCode: number | null; stdout: string };
    };
