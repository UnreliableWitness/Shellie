import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import { ExitError, runWithInput } from '../services/prSummary';
import type { FromHost, ToHost } from './protocol';

/** The part of node-pty the host uses. */
export type PtyModule = {
  spawn(
    file: string,
    args: string[],
    options: IPtyForkOptions | IWindowsPtyForkOptions,
  ): IPty;
};

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * The pty host's message handling (src/ptyHost.ts runs it in a utility process): starts ptys and headless runs and
 * posts their output, exits and results back. Messages for a process that is gone are ignored.
 */
export function createPtyHost(
  pty: PtyModule,
  post: (m: FromHost) => void,
  run: typeof runWithInput = runWithInput,
): (m: ToHost) => void {
  const procs = new Map<number, IPty>();
  const spawn = (m: Extract<ToHost, { t: 'spawn' }>) => {
    let proc: IPty;
    try {
      proc = pty.spawn(m.file, m.args, {
        name: 'xterm-256color',
        cols: m.cols,
        rows: m.rows,
        cwd: m.cwd,
        env: m.env,
        // Windows: the bundled conpty.dll. The default (system ConPTY) kill path forks a helper with
        // child_process.fork, which the RunAsNode fuse turns into a second Shellie.exe launch.
        // node-pty is pinned to 1.2.0-beta.15 or later: 1.1.0 has a data race on its Windows pty handle
        // list (microsoft/node-pty#921, fixed in 1.2.0-beta.13) that crashes the process with an access
        // violation when one pty exits while another is spawned, resized or killed.
        ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
      });
    } catch (e) {
      post({ t: 'spawnError', n: m.n, message: message(e) });
      return;
    }
    procs.set(m.n, proc);
    post({ t: 'spawned', n: m.n, pid: proc.pid });
    proc.onData((data) => post({ t: 'data', n: m.n, data }));
    proc.onExit(({ exitCode }) => {
      procs.delete(m.n);
      post({ t: 'exit', n: m.n, exitCode });
    });
  };
  return (m) => {
    switch (m.t) {
      case 'spawn':
        return spawn(m);
      case 'write':
        procs.get(m.n)?.write(m.data);
        return;
      case 'resize':
        try {
          procs.get(m.n)?.resize(m.cols, m.rows);
        } catch {
          // The pty closed in the meantime; its exit is on the way.
        }
        return;
      case 'kill':
        try {
          procs.get(m.n)?.kill();
        } catch {
          // Already gone; its exit is on the way.
        }
        return;
      case 'run':
        run(
          { command: m.command, args: m.args },
          { cwd: m.cwd, input: m.input, timeoutMs: m.timeoutMs, env: m.env },
        ).then(
          (stdout) => post({ t: 'ran', n: m.n, stdout }),
          (e: unknown) => {
            const code = (e as NodeJS.ErrnoException).code;
            post({
              t: 'runError',
              n: m.n,
              message: message(e),
              ...(typeof code === 'string' ? { code } : {}),
              ...(e instanceof ExitError
                ? { exit: { exitCode: e.exitCode, stdout: e.stdout } }
                : {}),
            });
          },
        );
        return;
    }
  };
}
