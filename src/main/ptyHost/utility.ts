import { utilityProcess } from 'electron';
import type { HostStarter } from './client';
import type { FromHost, ToHost } from './protocol';

/**
 * Starts the pty host (the bundled src/ptyHost.ts) in an Electron utility process. Chromium launches it off the
 * main thread, and it needs no RunAsNode fuse. Messages posted before it is up wait for it.
 */
export const utilityPtyHost =
  (modulePath: string): HostStarter =>
  (on) => {
    const child = utilityProcess.fork(modulePath, [], {
      serviceName: 'Shellie terminals',
    });
    let queue: ToHost[] | null = [];
    child.once('spawn', () => {
      for (const m of queue ?? []) child.postMessage(m);
      queue = null;
    });
    child.on('message', (m: FromHost) => on.message(m));
    child.once('exit', (code) => {
      console.error(`[terminals] the terminal host exited (${code})`);
      on.exit();
    });
    return {
      post: (m) => {
        if (queue) queue.push(m);
        else child.postMessage(m);
      },
    };
  };
