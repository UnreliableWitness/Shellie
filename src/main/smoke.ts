import os from 'node:os';
import type { Platform } from './platform/Platform';
import { type TerminalManager, UNKNOWN_EXIT } from './services/TerminalManager';

const MARKER = 'shellie-smoke-pty';

/**
 * The packaged-app smoke check (SHELLIE_SMOKE=1): one pty through TerminalManager, running a shell command
 * that prints a marker. True when the marker arrives and the command exits 0 (or with no known exit code)
 * within the timeout.
 * Touches no stores, so it is safe to run from CI against a fresh install.
 */
export async function runSmoke(o: {
  terminals: TerminalManager;
  platform: Platform;
  log: (line: string) => void;
  timeoutMs?: number;
}): Promise<boolean> {
  const id = 'shellie-smoke';
  const { terminals, log } = o;
  let timer: NodeJS.Timeout | undefined;
  try {
    const exited = new Promise<number>((resolve) => {
      terminals.on('exit', (exitId, code) => {
        if (exitId === id) resolve(code);
      });
    });
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), o.timeoutMs ?? 20_000);
    });
    // `echo` exists in sh, zsh and PowerShell (alias of Write-Output).
    const cmd = o.platform.runCommand(`echo ${MARKER}`);
    terminals.spawn({
      id,
      taskId: 'shellie-smoke',
      cwd: os.homedir(),
      ...cmd,
    });
    const result = await Promise.race([exited, timeout]);
    if (result === 'timeout') {
      log('smoke failed: the pty timed out');
      return false;
    }
    const output = terminals.buffer(id) ?? '';
    if (result === UNKNOWN_EXIT && output.includes(MARKER)) {
      // The pty closed before node-pty knew the code (conpty.dll); the marker proves the command ran.
      log('smoke: the pty reported no exit code, the marker arrived');
      return true;
    }
    if (result !== 0) {
      log(`smoke failed: exit code ${result}\n${output}`);
      return false;
    }
    if (!output.includes(MARKER)) {
      log(`smoke failed: the marker was not in the output\n${output}`);
      return false;
    }
    return true;
  } catch (e) {
    log(
      `smoke failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    return false;
  } finally {
    clearTimeout(timer);
    await terminals.kill(id);
  }
}
