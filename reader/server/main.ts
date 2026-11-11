import path from 'node:path';
import { createReaderServer } from './server';

const port = Number(process.env.PORT || 8080);
const dataDir = path.resolve(process.env.READER_DATA || '/data');
const publicDir = path.resolve(process.env.READER_PUBLIC || '/app/public');
const invite = process.env.READER_INVITE ?? '';

const server = createReaderServer({
  dataDir,
  publicDir,
  invite,
  log: (line) => console.log(line),
});

server.listen(port, '0.0.0.0', () => {
  const signUps = invite ? 'with an invitation code' : 'closed';
  console.log(`shellie-reader listening on ${port}, sign-ups ${signUps}`);
});

function stop(): void {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  // A connection that stays open must not keep the container from stopping.
  setTimeout(() => server.closeAllConnections(), 5000).unref();
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
