import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Handlers } from '../../shared/ipc';
import { RendererTelemetrySchema } from '../../shared/telemetry';
import type { Telemetry } from './AppInsightsClient';

/** `SHELLIE_TELEMETRY=0`, or the pre-rename `MIAC_TELEMETRY=0`, turns telemetry off for a launch. */
export const telemetryOptedOut = (env: NodeJS.ProcessEnv): boolean =>
  env.SHELLIE_TELEMETRY === '0' || env.MIAC_TELEMETRY === '0';

/** A random id for this installation, kept in userData; created on first use. Not tied to the user or machine. */
export async function installId(userData: string): Promise<string> {
  const file = path.join(userData, 'telemetry-id');
  try {
    const id = (await fs.readFile(file, 'utf8')).trim();
    if (/^[0-9a-f-]{36}$/i.test(id)) return id;
  } catch {
    // missing: create below
  }
  const id = randomUUID();
  try {
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(file, id, 'utf8');
  } catch {
    // An unwritable userData gives a new id per launch; telemetry must not fail the boot.
  }
  return id;
}

/**
 * Azure DevOps operation name without organization, project or ids:
 * `https://dev.azure.com/org/proj/_apis/wit/workitems/42?x=1` becomes `GET _apis/wit/workitems/{id}`.
 */
export function adoOperation(
  url: string,
  method = 'GET',
): { name: string; target: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { name: `${method} ado`, target: 'unknown' };
  }
  const segments = u.pathname.split('/').filter(Boolean);
  const at = segments.indexOf('_apis');
  const kept = at >= 0 ? segments.slice(at) : ['(other)'];
  const route = kept
    .map((s, i) =>
      /^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)
        ? '{id}'
        : kept[i - 1] === 'projects'
          ? '{project}'
          : kept[i - 1] === 'repositories'
            ? '{repo}'
            : s,
    )
    .join('/');
  const host = u.hostname.endsWith('.visualstudio.com')
    ? 'visualstudio.com'
    : u.hostname;
  return { name: `${method.toUpperCase()} ${route}`, target: host };
}

/** Wraps fetch so every Azure DevOps request is recorded as a dependency (name, duration, status; never the URL). */
export function timedFetch(
  telemetry: Telemetry,
  inner: typeof fetch = fetch,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const op = adoOperation(url, init?.method ?? 'GET');
    const t0 = performance.now();
    try {
      const res = await inner(input, init);
      telemetry.dependency({
        ...op,
        durationMs: performance.now() - t0,
        resultCode: String(res.status),
        success: res.status < 400,
      });
      return res;
    } catch (e) {
      telemetry.dependency({
        ...op,
        durationMs: performance.now() - t0,
        resultCode:
          e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'error',
        success: false,
      });
      throw e;
    }
  }) as typeof fetch;
}

/** Records a rejected IPC call as an exception tagged with its channel (never its arguments), then rethrows. */
export function trackHandlerFailures(
  handlers: Handlers,
  telemetry: Telemetry,
): Handlers {
  const out = {} as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const [channel, fn] of Object.entries(handlers) as [
    string,
    (...args: unknown[]) => Promise<unknown>,
  ][]) {
    out[channel] = async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        telemetry.exception(e, { source: 'ipc', channel });
        throw e;
      }
    };
  }
  return out as Handlers;
}

/** Validates one message from the renderer and forwards it. Anything malformed is ignored. */
export function forwardRendererTelemetry(
  payload: unknown,
  telemetry: Telemetry,
): void {
  const parsed = RendererTelemetrySchema.safeParse(payload);
  if (!parsed.success) return;
  const m = parsed.data;
  const props = { ...m.props, process: 'renderer' };
  if (m.type === 'event') telemetry.event(m.name, props);
  else if (m.type === 'pageView') telemetry.pageView(m.name, props);
  else
    telemetry.exceptionParts(
      { errorType: m.errorType, message: m.message, stack: m.stack },
      props,
    );
}

/** Keys whose value differs between two settings objects (values themselves are not sent). */
export function changedKeys<T extends object>(before: T, after: T): string[] {
  return (Object.keys(after) as (keyof T)[])
    .filter(
      (k) =>
        before[k] !== after[k] &&
        // Nested values (work hours) are rebuilt on every load, so compare them by content.
        JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    )
    .map(String)
    .sort();
}

/** Every value that could identify a customer, a repo or a person, for `scrub`. */
export function sensitiveValues(src: {
  repos: { name: string; path: string }[];
  tasks: {
    name: string;
    branch: string;
    slug: string;
    worktreePath: string;
    workItem: { title: string } | null;
    pullRequest?: { project: string; repo: string } | null;
  }[];
  connections: {
    name: string;
    organizationUrl: string;
    project: string;
    user: string | null;
  }[];
  /** Brains: their names and folders can name a customer. */
  brains?: { name: string; path: string }[];
  username?: string;
  /** Values learned at run time, such as the project and repo of an Azure Repos remote. */
  extra?: Iterable<string>;
}): string[] {
  const out: string[] = [];
  for (const r of src.repos) out.push(r.name, r.path);
  for (const b of src.brains ?? []) out.push(b.name, b.path);
  for (const t of src.tasks) {
    out.push(t.name, t.branch, t.slug, t.worktreePath);
    if (t.workItem) out.push(t.workItem.title);
    if (t.pullRequest) out.push(t.pullRequest.project, t.pullRequest.repo);
  }
  for (const c of src.connections) {
    out.push(c.name, c.organizationUrl, c.project);
    const org = c.organizationUrl.replace(/\/+$/, '').split('/').pop();
    if (org) out.push(org);
    if (c.user) out.push(c.user);
  }
  if (src.username) out.push(src.username);
  out.push(...(src.extra ?? []));
  return out.filter((v) => v.trim().length > 0);
}
