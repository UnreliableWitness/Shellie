import * as pty from 'node-pty';
import { PtyHostClient } from '../ptyHost/client';
import { createPtyHost } from '../ptyHost/host';

/**
 * The pty host in this process, with real node-pty: messages cross asynchronously both ways, as with the utility
 * process, so tests run the whole protocol.
 */
export function inProcessPtyHost(): PtyHostClient {
  return new PtyHostClient((on) => {
    const handle = createPtyHost(pty, (m) => setImmediate(() => on.message(m)));
    return { post: (m) => setImmediate(() => handle(m)) };
  });
}
