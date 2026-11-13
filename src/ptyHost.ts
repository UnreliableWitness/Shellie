import * as pty from 'node-pty';
import { createPtyHost } from './main/ptyHost/host';
import type { ToHost } from './main/ptyHost/protocol';

// The pty host's utility process (src/main/ptyHost/utility.ts starts it): terminals and headless jobs start here.
const port = process.parentPort;
const handle = createPtyHost(pty, (m) => port.postMessage(m));
port.on('message', (e: { data: ToHost }) => handle(e.data));
