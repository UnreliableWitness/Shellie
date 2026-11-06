import {
  HOME_TIMEOUT_MS,
  HomeSnapshotSchema,
  type HomeConnection,
  type HomePr,
  type HomeSnapshot,
  type HomeSprint,
} from '../../shared/home';
import type { Connection, SprintIteration } from '../../shared/types';
import { AdoError, type AdoClient } from '../services/AdoClient';
import { JsonFileStore } from '../usage/JsonFileStore';
import { toHomePr } from './homePr';
import { errorMessage } from '../../shared/errors';
import { withTimeout } from '../async';

export type HomeClient = Pick<
  AdoClient,
  | 'me'
  | 'myTeams'
  | 'currentIteration'
  | 'assignedInIterations'
  | 'workItems'
  | 'activePullRequests'
>;

export type HomeDeps = {
  file: string;
  connections: () => Connection[];
  client: (connectionId: string) => HomeClient;
  /** Runs one connection's call so its status in Settings follows (handlers pass `withConnection`). */
  withConnection?: <T>(
    connectionId: string,
    run: () => Promise<T>,
  ) => Promise<T>;
  now?: () => Date;
  timeoutMs?: number;
  onBuilt?: (
    snapshot: HomeSnapshot,
    info: {
      connections: number;
      failed: number;
      /** One entry per connection that failed or had a failing step; no names or IDs. */
      failures: { kind: HomeFailureKind }[];
      durationMs: number;
    },
  ) => void;
};

export type HomeFailureKind =
  | 'unauthorized'
  | 'unreachable'
  | 'timeout'
  | 'step';

type Call = <T>(run: () => Promise<T>) => Promise<T>;

const byCreated = (a: HomePr, b: HomePr) =>
  a.createdAt.localeCompare(b.createdAt);

/** Builds Home's cross-connection snapshot; one rebuild at a time, the last one cached on disk. */
export class HomeService {
  private readonly store: JsonFileStore<HomeSnapshot | null>;
  private loaded: Promise<unknown> | null = null;
  private running: Promise<HomeSnapshot> | null = null;

  constructor(private readonly d: HomeDeps) {
    this.store = new JsonFileStore<HomeSnapshot | null>(
      d.file,
      HomeSnapshotSchema.nullable(),
      () => null,
    );
  }

  private load(): Promise<unknown> {
    this.loaded ??= this.store.load().catch(() => undefined);
    return this.loaded;
  }

  async get(): Promise<HomeSnapshot | null> {
    await this.load();
    return this.store.value;
  }

  refresh(): Promise<HomeSnapshot> {
    this.running ??= this.build().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async build(): Promise<HomeSnapshot> {
    await this.load();
    const started = Date.now();
    const prev = new Map(
      (this.store.value?.connections ?? []).map((c) => [c.connectionId, c]),
    );
    const failures: { kind: HomeFailureKind }[] = [];
    let list: Connection[] = [];
    try {
      list = this.d.connections();
    } catch (e) {
      console.error('[home] could not list the connections', e);
    }
    const connections = await Promise.all(
      list.map((c) => this.connection(c, prev.get(c.id) ?? null, failures)),
    );
    const snapshot: HomeSnapshot = {
      version: 1,
      builtAt: this.now().toISOString(),
      connections,
    };
    await this.store
      .update(() => snapshot)
      .catch((e: unknown) =>
        console.error('[home] could not save the snapshot', e),
      );
    for (const c of connections)
      if (c.status === 'ok' && (c.sprintsError || c.prsError))
        failures.push({ kind: 'step' });
    try {
      this.d.onBuilt?.(snapshot, {
        connections: connections.length,
        failed: connections.filter((c) => c.status !== 'ok').length,
        failures,
        durationMs: Date.now() - started,
      });
    } catch (e) {
      console.error('[home] onBuilt failed', e);
    }
    return snapshot;
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  private async connection(
    c: Connection,
    prev: HomeConnection | null,
    failures: { kind: HomeFailureKind }[],
  ): Promise<HomeConnection> {
    const ms = this.d.timeoutMs ?? HOME_TIMEOUT_MS;
    const fail = (kind: HomeFailureKind, error: string) => {
      failures.push({ kind });
      return this.failed(c, prev, error);
    };
    let fetched: HomeConnection | null;
    try {
      fetched = await withTimeout<HomeConnection | null>(
        this.fetch(c, prev),
        ms,
        () => null,
      );
    } catch (e) {
      return fail(
        e instanceof AdoError && e.kind === 'unauthorized'
          ? 'unauthorized'
          : 'unreachable',
        errorMessage(e),
      );
    }
    return (
      fetched ??
      fail('timeout', `Azure DevOps did not answer within ${ms / 1000} s`)
    );
  }

  private failed(
    c: Connection,
    prev: HomeConnection | null,
    error: string,
  ): HomeConnection {
    const base = { connectionId: c.id, name: c.name, project: c.project };
    return prev && prev.fetchedAt !== null
      ? { ...prev, ...base, status: 'stale', error }
      : {
          ...base,
          status: 'error',
          error,
          fetchedAt: null,
          sprints: [],
          sprintsError: null,
          reviews: [],
          teamReviews: [],
          myPrs: [],
          prsError: null,
        };
  }

  private async fetch(
    c: Connection,
    prev: HomeConnection | null,
  ): Promise<HomeConnection> {
    const client = this.d.client(c.id);
    const call: Call = (run) =>
      this.d.withConnection ? this.d.withConnection(c.id, run) : run();
    // Teams load alongside me but pass through `call` only once me succeeded, so a failing me
    // still fails the connection alone and the status updates keep their order.
    const meCall = call(() => client.me());
    const myTeams = client.myTeams(c.project);
    myTeams.catch(() => {});
    const me = await meCall;
    const teamsResult = await call(() => myTeams).then(
      (value) => ({ ok: true as const, value }),
      (reason: unknown) => ({ ok: false as const, reason }),
    );
    const teams = teamsResult.ok ? teamsResult.value : [];
    const [sprints, prs] = await Promise.allSettled([
      teamsResult.ok
        ? this.sprintsOf(c, client, call, teams)
        : Promise.reject(teamsResult.reason),
      this.prs(
        c,
        client,
        me,
        teams.map((t) => t.id),
      ),
    ]);
    const part = sprints.status === 'fulfilled' ? sprints.value : null;
    return {
      connectionId: c.id,
      name: c.name,
      project: c.project,
      status: 'ok',
      error: null,
      fetchedAt: this.now().toISOString(),
      sprints: part?.sprints ?? prev?.sprints ?? [],
      sprintsError: part
        ? part.error
        : sprints.status === 'rejected'
          ? errorMessage(sprints.reason)
          : null,
      reviews:
        prs.status === 'fulfilled' ? prs.value.reviews : (prev?.reviews ?? []),
      teamReviews:
        prs.status === 'fulfilled' && teamsResult.ok
          ? prs.value.teamReviews
          : (prev?.teamReviews ?? []),
      myPrs: prs.status === 'fulfilled' ? prs.value.myPrs : (prev?.myPrs ?? []),
      prsError: prs.status === 'rejected' ? errorMessage(prs.reason) : null,
    };
  }

  /** Current iterations of my teams, each team on its own: a failing team sets the error, the others still count. */
  private async sprintsOf(
    c: Connection,
    client: HomeClient,
    call: Call,
    teams: { id: string; name: string }[],
  ): Promise<{ sprints: HomeSprint[] | null; error: string | null }> {
    const found = await Promise.allSettled(
      teams.map((t) => call(() => client.currentIteration(c.project, t.name))),
    );
    const failure = found.find((f) => f.status === 'rejected');
    const error = failure ? errorMessage(failure.reason) : null;
    if (failure && found.every((f) => f.status === 'rejected'))
      return { sprints: null, error };
    const iterations = [
      ...new Map(
        found
          .flatMap((f) =>
            f.status === 'fulfilled' && f.value ? [f.value] : [],
          )
          .map((i: SprintIteration) => [i.path, i]),
      ).values(),
    ];
    return { sprints: await this.sprints(c, client, call, iterations), error };
  }

  private async sprints(
    c: Connection,
    client: HomeClient,
    call: Call,
    iterations: SprintIteration[],
  ): Promise<HomeSprint[]> {
    const ids = await call(() =>
      client.assignedInIterations(
        c.project,
        iterations.map((i) => i.path),
      ),
    );
    const items = ids.length
      ? await call(() => client.workItems(c.project, ids))
      : [];
    return iterations
      .map((i) => ({
        iterationId: i.id,
        name: i.name,
        path: i.path,
        startDate: i.startDate,
        finishDate: i.finishDate,
        items: items.filter((w) => w.iterationPath === i.path),
      }))
      .filter((s) => s.items.length > 0)
      .sort((a, b) => (a.finishDate ?? '9').localeCompare(b.finishDate ?? '9'));
  }

  private async prs(
    c: Connection,
    client: HomeClient,
    me: string,
    teamIds: string[],
  ): Promise<{ reviews: HomePr[]; teamReviews: HomePr[]; myPrs: HomePr[] }> {
    const ctx = { organizationUrl: c.organizationUrl, project: c.project, me };
    const map = (raw: Awaited<ReturnType<HomeClient['activePullRequests']>>) =>
      raw.flatMap((r) => {
        const p = toHomePr(r, ctx);
        return p ? [p] : [];
      });
    // Not through withConnection: a missing Code scope must only set prsError, never mark the connection unauthorized.
    const [named, mine, ...byTeam] = await Promise.all([
      client.activePullRequests(c.project, { reviewerId: me }).then(map),
      client.activePullRequests(c.project, { creatorId: me }).then(map),
      ...teamIds.map((id) =>
        client.activePullRequests(c.project, { reviewerId: id }).then(map),
      ),
    ]);
    const team = new Map<number, HomePr>();
    for (const p of byTeam.flat())
      if (p.myVote === null && p.authorId !== me) team.set(p.id, p);
    return {
      reviews: named
        .filter((p) => p.myVote === 0 && p.authorId !== me)
        .sort(byCreated),
      teamReviews: [...team.values()].sort(byCreated),
      myPrs: mine.sort((a, b) => byCreated(b, a)),
    };
  }
}
