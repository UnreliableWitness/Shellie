import { parentPort } from 'node:worker_threads';
import {
  createReadHandler,
  type ReadRequest,
} from './main/budget/openCodeRemote';

const handle = createReadHandler();
parentPort?.on('message', (request: ReadRequest) => {
  parentPort?.postMessage(handle(request));
});
