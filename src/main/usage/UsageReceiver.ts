import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  AttentionPostSchema,
  clampMessage,
  type AttentionSignal,
} from '../../shared/attention';
import type { UsageEvent } from '../../shared/usage';
import { RUN_EXIT, type RunHub } from '../secrets/RunHub';
import { perf } from '../telemetry/perf';
import {
  type ClaudeActive,
  parseClaudeActiveTime,
  parseClaudeLogs,
} from './otlp';

const LIMIT = 5 * 1024 * 1024;
/** A `shellie run` request is a name and its arguments. */
const RUN_LIMIT = 1024 * 1024;

const RunPostSchema = z.object({
  name: z.string().max(200),
  args: z.array(z.string()).max(200).default([]),
  workspace: z.string().max(4096).optional(),
  terminal: z.string().max(200).optional(),
});

/** The run route's side of RunHub. */
const ROUTES = new Set(['/v1/logs', '/v1/metrics', '/v1/attention', '/v1/run']);

export type RunRoute = Pick<RunHub, 'taskFor' | 'names' | 'start'>;
type Status = { listening: boolean; port: number; error: string | null };

/**
 * OTLP/HTTP JSON endpoint on 127.0.0.1 for Claude Code log events, the attention route for the OpenCode plugin,
 * and `/v1/run` for the `shellie run` shim (a per-task bearer token).
 */
export class UsageReceiver {
  private server: Server | null = null;
  private current: Status = { listening: false, port: 0, error: null };

  constructor(
    private readonly onEvents: (events: UsageEvent[]) => void,
    private readonly onActiveTime?: (points: ClaudeActive[]) => void,
    private readonly attention?: {
      token: string;
      onSignal: (terminalId: string, s: AttentionSignal) => boolean;
    },
    private readonly runs?: RunRoute,
  ) {}

  get status(): Status {
    return this.current;
  }

  async start(port: number): Promise<Status> {
    await this.stop();
    const server = createServer((req, res) => this.handle(req, res));
    this.current = await new Promise<Status>((resolve) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        resolve({
          listening: false,
          port,
          error:
            e.code === 'EADDRINUSE'
              ? `Port ${port} is in use by another program`
              : e.message,
        });
      });
      server.listen(port, '127.0.0.1', () =>
        resolve({ listening: true, port, error: null }),
      );
    });
    this.server = this.current.listening ? server : null;
    return this.current;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.current = { ...this.current, listening: false };
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const reply = (status: number, body = '{}') => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    const path = (req.url ?? '').split('?')[0];
    // Metric `usage.receive.ms`: a refused post (400, 413, 415, 500) is AI usage that was not priced.
    const t0 = performance.now();
    res.once('finish', () => {
      const route = ROUTES.has(path) ? path : 'other';
      const ok = res.statusCode < 400;
      perf.record(
        'usage.receive.ms',
        ok ? route : `${route} ${res.statusCode}`,
        performance.now() - t0,
        ok ? 'ok' : 'failed',
      );
    });
    if (path === '/v1/run' && this.runs !== undefined)
      return this.handleRun(req, res, this.runs);
    const isAttention =
      path === '/v1/attention' && this.attention !== undefined;
    if (!isAttention && path !== '/v1/logs' && path !== '/v1/metrics')
      return reply(404);
    if (req.method !== 'POST') return reply(405);
    if (
      isAttention &&
      req.headers['x-shellie-token'] !== this.attention!.token
    ) {
      req.resume();
      return reply(403);
    }
    if (
      !(req.headers['content-type'] ?? '')
        .toLowerCase()
        .startsWith('application/json')
    ) {
      req.resume();
      return reply(415);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > LIMIT) {
        tooBig = true;
        reply(413);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (isAttention) {
        let body: ReturnType<typeof AttentionPostSchema.parse>;
        try {
          body = AttentionPostSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString('utf8')),
          );
        } catch {
          return reply(400);
        }
        const { terminalId, state, kind } = body;
        const message = body.message ? clampMessage(body.message) : '';
        const known = this.attention!.onSignal(terminalId, {
          state,
          ...(kind ? { kind } : {}),
          ...(message ? { message } : {}),
        });
        return reply(known ? 200 : 404);
      }
      let events: UsageEvent[] = [];
      let skipped = 0;
      let active: ClaudeActive[] = [];
      try {
        let buf = Buffer.concat(chunks);
        if ((req.headers['content-encoding'] ?? '').toLowerCase() === 'gzip')
          buf = gunzipSync(buf, { maxOutputLength: LIMIT });
        const doc: unknown = JSON.parse(buf.toString('utf8'));
        if (path === '/v1/metrics') active = parseClaudeActiveTime(doc);
        else ({ events, skipped } = parseClaudeLogs(doc));
      } catch (e) {
        const tooLarge =
          (e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ||
          (e instanceof RangeError && /larger|size/i.test(e.message));
        return reply(tooLarge ? 413 : 400);
      }
      if (skipped > 0)
        console.warn(
          `[usage] skipped ${skipped} api_request record(s) without a model or request id`,
        );
      try {
        if (events.length > 0) this.onEvents(events);
        if (active.length > 0) this.onActiveTime?.(active);
      } catch (e) {
        console.error('[usage] failed to handle usage data', e);
        return reply(500);
      }
      reply(200);
    });
  }

  /**
   * `shellie run`: GET lists the task's names, POST runs one. The bearer token says which task; a wrong one is
   * 401. The body is JSON `{ name, args, workspace?, terminal? }` or a form (`name`, `arg` repeated, ...: the sh
   * shim cannot build JSON safely). The answer streams as text and ends with the line `\0exit:<code>`.
   */
  private handleRun(
    req: IncomingMessage,
    res: ServerResponse,
    runs: RunRoute,
  ): void {
    const fail = (status: number, text: string) => {
      req.resume();
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(text ? `${text}\n` : '');
    };
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const taskId = auth ? runs.taskFor(auth[1]!) : null;
    // No body: the shim prints its own message.
    if (taskId === null) return fail(401, '');
    let ended = false;
    let last = '\n';
    const stream = () =>
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
    const out = (chunk: string) => {
      if (ended || chunk === '' || res.destroyed) return;
      last = chunk;
      res.write(chunk);
    };
    const end = (code: number) => {
      if (ended || res.destroyed) return;
      ended = true;
      res.end(`${last.endsWith('\n') ? '' : '\n'}${RUN_EXIT}${code}\n`);
    };
    if (req.method === 'GET') {
      const folder =
        new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get(
          'workspace',
        ) ?? undefined;
      req.resume();
      void runs.names(taskId, folder).then(
        (names) => {
          stream();
          out(
            names.length > 0
              ? `Commands for shellie run: ${names.join(', ')}\n`
              : 'This task has no commands for shellie run; add them under run: in .shellie.yml\n',
          );
          end(0);
        },
        () => fail(500, 'Shellie could not read the commands'),
      );
      return;
    }
    if (req.method !== 'POST') return fail(405, 'Use GET or POST');
    const type = (req.headers['content-type'] ?? '').toLowerCase();
    const form = type.startsWith('application/x-www-form-urlencoded');
    if (!form && !type.startsWith('application/json'))
      return fail(415, 'Send JSON or a form');
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > RUN_LIMIT) {
        tooBig = true;
        fail(413, 'Too large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      let body: z.infer<typeof RunPostSchema>;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        if (form) {
          const p = new URLSearchParams(text);
          body = RunPostSchema.parse({
            name: p.get('name'),
            args: p.getAll('arg'),
            workspace: p.get('workspace') ?? undefined,
            terminal: p.get('terminal') || undefined,
          });
        } else body = RunPostSchema.parse(JSON.parse(text));
      } catch {
        return fail(400, 'Expected a name and string arguments');
      }
      const ac = new AbortController();
      // The agent cancelled (or the shim died): the run stops.
      res.on('close', () => {
        if (!ended) ac.abort();
      });
      stream();
      runs
        .start(taskId, body.name, body.args, out, {
          ...(body.workspace ? { workspace: body.workspace } : {}),
          ...(body.terminal ? { terminal: body.terminal } : {}),
          signal: ac.signal,
        })
        .then(end, () => {
          out('Shellie could not run the command\n');
          end(1);
        });
    });
  }
}
