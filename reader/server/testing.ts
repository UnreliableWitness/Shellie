import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createReaderServer, type Limits } from './server';

// Test helpers for the server's own tests; not part of the bundle.

export const INVITE = 'the-invitation-code';

export type Running = {
  url: string;
  port: number;
  dataDir: string;
  publicDir: string;
  logs: string[];
  /** Moves the server's clock forward. */
  advance: (ms: number) => void;
  close: () => Promise<void>;
};

export type StartOptions = {
  dataDir?: string;
  publicDir?: string;
  invite?: string;
  limits?: Partial<Limits>;
};

const dirs: string[] = [];
const running: Running[] = [];

export async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-reader-'));
  dirs.push(dir);
  return dir;
}

export async function start(opts: StartOptions = {}): Promise<Running> {
  const dataDir = opts.dataDir ?? (await tempDir());
  const publicDir = opts.publicDir ?? (await tempDir());
  const logs: string[] = [];
  let clock = Date.parse('2026-11-11T10:00:00.000Z');
  const server = createReaderServer({
    dataDir,
    publicDir,
    invite: opts.invite ?? INVITE,
    limits: opts.limits,
    now: () => new Date(clock),
    log: (line) => logs.push(line),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  const it: Running = {
    url: `http://127.0.0.1:${port}`,
    port,
    dataDir,
    publicDir,
    logs,
    advance: (ms) => void (clock += ms),
    close,
  };
  running.push(it);
  return it;
}

/** Stops every server and removes every folder a test made. */
export async function cleanUp(): Promise<void> {
  await Promise.all(running.splice(0).map((server) => server.close()));
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
}

export type Who = { reader: string; token: string; bearer: string };

export function someone(): Who {
  const reader = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('base64url');
  return { reader, token, bearer: `Bearer ${reader}.${token}` };
}

export function itemId(kind = 'r'): string {
  return `${kind}-${randomBytes(16).toString('hex')}`;
}

export function signUp(
  server: Running,
  who: Who,
  invite: string | null = INVITE,
  headers: Record<string, string> = {},
): Promise<Response> {
  const { reader, token } = who;
  return fetch(`${server.url}/api/v1/readers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    // null: a body without an invitation
    body: JSON.stringify({ invite: invite ?? undefined, reader, token }),
  });
}

/** A new account on the server. */
export async function join(server: Running): Promise<Who> {
  const who = someone();
  const res = await signUp(server, who);
  if (res.status !== 200) throw new Error(`sign-up answered ${res.status}`);
  return who;
}

export function call(
  server: Running,
  who: Who | null,
  method: string,
  pathname: string,
  body?: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${server.url}${pathname}`, {
    method,
    // fetch takes the bytes; its types want a view on a plain ArrayBuffer
    body: body as BodyInit | undefined,
    headers: {
      ...(who ? { Authorization: who.bearer } : {}),
      ...(body ? { 'Content-Type': 'application/octet-stream' } : {}),
      ...headers,
    },
  });
}

export function put(
  server: Running,
  who: Who,
  id: string,
  text: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const body = new TextEncoder().encode(text);
  return call(server, who, 'PUT', `/api/v1/items/${id}`, body, headers);
}

export type RawAnswer = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

/**
 * A request whose path goes out exactly as written (`fetch` resolves `..`
 * before sending), with an optional body sent in chunks without a length.
 */
export function raw(
  server: Running,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  chunks: Buffer[] = [],
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.port, method, path: pathname, headers },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}
