import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BudgetRecord } from '../../shared/budget';
import type { CostRecord } from '../../shared/ledger';
import { attributionContext } from '../ledger/attribute';
import { LedgerService } from '../ledger/LedgerService';
import { LedgerStore } from '../ledger/LedgerStore';
import type { TokenCrypto } from '../services/ConnectionStore';
import { CostSender } from './CostSender';
import { CostServerStore } from './CostServerStore';

const KEY = 'secret-key';
const EMAIL = 'dev@example.com';

/** A cost server in miniature: bearer key, hello with budgets, records upserted by id. */
function startServer(port = 0) {
  const stored = new Map<string, unknown>();
  const bodies: string[] = [];
  let posts = 0;
  let attempts = 0;
  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST') attempts++;
    if (req.headers.authorization !== `Bearer ${KEY}`)
      return json(401, { error: 'key' });
    if (req.method === 'GET' && req.url?.startsWith('/api/v1/hello'))
      return json(200, {
        server: 'shellie-cost',
        version: '0',
        developer: {
          email: EMAIL,
          budgets: {
            claude: { monthlyEur: 100, monthStartDay: 1 },
            copilot: null,
          },
        },
      });
    if (req.method === 'POST' && req.url === '/api/v1/records') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        posts++;
        bodies.push(body);
        const { records } = JSON.parse(body) as {
          records: { id: string }[];
        };
        for (const r of records) stored.set(r.id, r);
        json(200, { server: 'shellie-cost', accepted: records.length });
      });
      return;
    }
    json(404, {});
  });
  return new Promise<{
    port: number;
    stored: Map<string, unknown>;
    bodies: string[];
    posts: () => number;
    attempts: () => number;
    close: () => Promise<void>;
  }>((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        stored,
        bodies,
        posts: () => posts,
        attempts: () => attempts,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

const crypto: TokenCrypto = {
  available: () => true,
  encrypt: (s) => Buffer.from(`x${s}`),
  decrypt: (b) => b.toString().slice(1),
};

const rec = (i: number, o: Partial<CostRecord> = {}): CostRecord => ({
  id: `cc:m${i}`,
  tool: 'claude-code',
  provider: 'anthropic',
  vendor: 'claude',
  model: 'claude-sonnet-5-5',
  modelLabel: 'Sonnet 5.5',
  at: `2026-10-12T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
  fast: false,
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  costUsd: 0.01,
  costEur: 0.0092,
  rateId: 'r',
  billable: true,
  attribution: {
    level: 'task',
    taskId: 't1',
    organization: 'https://dev.azure.com/acme',
    project: 'Shop',
    workItemId: 42,
    workItemTitle: 'Fix login',
    workItemType: 'Bug',
    repo: 'web',
  },
  developer: EMAIL,
  shellieVersion: '9.9.0',
  ...o,
});

let dir: string;
let servers: { close: () => Promise<void> }[] = [];
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cost-int-'));
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.map((s) => s.close().catch(() => {})));
  servers = [];
  await fs.rm(dir, { recursive: true, force: true });
});

async function setup(key = KEY, port = 0) {
  const server = await startServer(port);
  servers.push(server);
  const ledger = new LedgerStore(path.join(dir, 'ledger'));
  await ledger.load();
  const cs = new CostServerStore(path.join(dir, 'cost-server.json'), crypto);
  await cs.load();
  await cs.set({ url: `http://127.0.0.1:${server.port}`, email: EMAIL, key });
  const sender = new CostSender({
    ledger,
    server: cs,
    status: () => {},
    notice: () => {},
    telemetry: () => {},
  });
  return { server, ledger, cs, sender };
}

const settle = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
};

describe('cost server end to end', () => {
  it('connects, stores the budgets and delivers every record once, with no private fields', async () => {
    const { server, ledger, cs, sender } = await setup();
    await ledger.upsert(Array.from({ length: 5 }, (_, i) => rec(i)));
    await sender.onConnected();
    await settle(5_000);
    await vi.waitFor(() => expect(server.stored.size).toBe(5));
    expect(ledger.dirty(100)).toEqual([]);
    expect(server.posts()).toBe(1);
    expect(cs.budgets).toEqual({
      claude: { monthlyEur: 100, monthStartDay: 1 },
      copilot: null,
    });
    for (const body of server.bodies) {
      expect(body).not.toMatch(
        /"(cwd|prompt|content|text|message|path)"|\/Users\/|\/home\/|C:\\\\/,
      );
    }
    sender.stop();
  });

  it('after an outage the new records arrive exactly once and nothing is doubled', async () => {
    const first = await setup();
    await first.ledger.upsert([rec(1), rec(2)]);
    await first.sender.onConnected();
    await settle(5_000);
    await vi.waitFor(() => expect(first.server.stored.size).toBe(2));
    const { port } = first.server;
    await first.server.close();

    await first.ledger.upsert([rec(3), rec(4)]);
    first.sender.kick();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(first.sender.status().error).not.toBeNull();
    });
    expect(first.ledger.dirty(100).map((r) => r.id)).toEqual([
      'cc:m3',
      'cc:m4',
    ]);

    const again = await startServer(port);
    servers.push(again);
    // Backoff of 60 s, then the retry.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(again.stored.size).toBe(2));
    expect([...again.stored.keys()].sort()).toEqual(['cc:m3', 'cc:m4']);
    // The server stores before it answers; the ledger is marked clean only once the answer arrives.
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(first.ledger.dirty(100)).toEqual([]);
    });
    const ids = again.bodies.flatMap((b) =>
      (JSON.parse(b) as { records: { id: string }[] }).records.map((r) => r.id),
    );
    expect(ids).toEqual(['cc:m3', 'cc:m4']);
    first.sender.stop();
  });

  it('a wrong key is an auth error and nothing more is sent', async () => {
    const { server, ledger, sender } = await setup('wrong');
    await ledger.upsert([rec(1)]);
    await sender.onConnected();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(sender.status().error).toBe('The server refused the key');
    });
    // The refused key was tried once (hello); records were never posted.
    expect(server.attempts()).toBe(0);
    const helloFailed = sender.status().error;
    sender.kick();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(server.attempts()).toBe(0);
    expect(server.posts()).toBe(0);
    expect(sender.status().error).toBe(helloFailed);
    expect(ledger.dirty(10)).toHaveLength(1);
    sender.stop();
  });

  it('a first connect sends the stored history once, with the email; a new email sends it again', async () => {
    const server = await startServer();
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}`;
    const store = new LedgerStore(path.join(dir, 'ledger'));
    const cs = new CostServerStore(path.join(dir, 'cost-server.json'), crypto);
    await cs.load();
    const sender = new CostSender({
      ledger: store,
      server: cs,
      status: () => {},
      notice: () => {},
      telemetry: () => {},
    });
    const history: BudgetRecord[] = [1, 2, 3].map((i) => ({
      id: `cc:h${i}`,
      tool: 'claude-code',
      sessionId: 'S',
      model: 'claude-sonnet-5-5',
      provider: 'anthropic',
      at: `2026-10-12T10:0${i}:00.000Z`,
      cwd: null,
      fast: false,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    }));
    const queue = [history];
    const ledger = new LedgerService({
      store,
      claude: {
        read: async (cursors) => ({
          records: queue.shift() ?? [],
          cursors,
          found: true,
        }),
      },
      openCode: { read: () => ({ records: [], cursor: 0, found: false }) },
      usageRecords: () => [],
      context: () => attributionContext([], [], []),
      isBillable: () => true,
      developer: () => cs.get()?.email ?? null,
      version: '9.9.0',
      toUsage: () => {},
      changed: () => sender.kick(),
    });
    sender.start();
    // Before any connection: the backfill is stored without a developer.
    await ledger.pass();
    expect(store.all().map((r) => r.developer)).toEqual([null, null, null]);

    // What costServer:connect does: save, a fresh ledger pass, then the sender starts over.
    const connect = async (email: string) => {
      await cs.set({ url, email, key: KEY });
      await ledger.freshPass();
      await sender.onConnected();
      await settle(5_000);
    };
    const sent = () =>
      server.bodies.flatMap((b) =>
        (
          JSON.parse(b) as { records: { id: string; developer: string }[] }
        ).records.map((r) => `${r.id} ${r.developer}`),
      );
    await connect(EMAIL);
    await vi.waitFor(() => expect(server.stored.size).toBe(3));
    await ledger.pass();
    await settle(5 * 60_000);
    expect(sent()).toEqual([
      `cc:h1 ${EMAIL}`,
      `cc:h2 ${EMAIL}`,
      `cc:h3 ${EMAIL}`,
    ]);

    server.bodies.length = 0;
    await connect('new@example.com');
    await vi.waitFor(() => expect(sent()).toHaveLength(3));
    expect(sent()).toEqual([
      'cc:h1 new@example.com',
      'cc:h2 new@example.com',
      'cc:h3 new@example.com',
    ]);
    expect(store.dirty(10)).toEqual([]);
    sender.stop();
  });
});
