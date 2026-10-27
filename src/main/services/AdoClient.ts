import { buildSprintTree, type SprintRelation } from '../../shared/sprintTree';
import type {
  Sprint,
  SprintItem,
  SprintIteration,
  WorkItemDetails,
  WorkItemStateMeta,
  WorkItemSummary,
  WorkItemTypeMeta,
} from '../../shared/types';
import { errorMessage } from '../../shared/errors';

export type AdoErrorKind =
  | 'unauthorized'
  | 'not-found'
  | 'unreachable'
  | 'http';

export class AdoError extends Error {
  constructor(
    public readonly kind: AdoErrorKind,
    public readonly path: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AdoError';
  }
}

const API = 'api-version=7.1';
const EXCLUDED_STATES = ['Closed', 'Removed', 'Done', 'Resolved'];
const FIELDS = [
  'System.Id',
  'System.WorkItemType',
  'System.Title',
  'System.State',
  'System.AreaPath',
  'System.IterationPath',
  'System.AssignedTo',
];
const REMAINING_WORK = 'Microsoft.VSTS.Scheduling.RemainingWork';
const ORIGINAL_ESTIMATE = 'Microsoft.VSTS.Scheduling.OriginalEstimate';
const COMPLETED_WORK = 'Microsoft.VSTS.Scheduling.CompletedWork';
/** The estimate fields in hours; ADO leaves a field out when it is unset. */
const ESTIMATE_FIELDS = [ORIGINAL_ESTIMATE, REMAINING_WORK, COMPLETED_WORK];
const hoursOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const MAX_RESULTS = 50;
/** The work items batch API takes at most 200 ids per call. */
const BATCH = 200;
/** Type icons are small SVGs; anything bigger is not an icon. */
const MAX_ICON_BYTES = 256 * 1024;
/** The only icon formats accepted; anything else could be interpolated into a data URL in odd ways. */
const ICON_TYPES = new Set(['image/svg+xml', 'image/png']);

/** ADO sends colors as `rrggbb` without the hash; null for anything else. */
export const hexColor = (c: unknown): string | null =>
  typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c)
    ? `#${c.replace('#', '').toLowerCase()}`
    : null;

const wiqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

export function buildWiql(opts: {
  scope: 'sprint' | 'mine';
  text: string;
  iterationPath: string | null;
}): string {
  const where = [
    '[System.TeamProject] = @project',
    `[System.State] NOT IN (${EXCLUDED_STATES.map(wiqlString).join(', ')})`,
  ];
  if (opts.scope === 'mine') where.push('[System.AssignedTo] = @Me');
  else if (opts.iterationPath)
    where.push(`[System.IterationPath] = ${wiqlString(opts.iterationPath)}`);
  const text = opts.text.trim();
  if (text.length > 0) {
    const title = `[System.Title] CONTAINS ${wiqlString(text)}`;
    where.push(
      /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 2147483647
        ? `([System.Id] = ${Number(text)} OR ${title})`
        : title,
    );
  }
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
}

export const WRITE_DENIED =
  'The token cannot write work items (needs Work Items: Read & write)';

export const CODE_READ_DENIED =
  'The token cannot read repositories or pull requests (needs Code: Read & write)';

export const CODE_WRITE_DENIED =
  'The token cannot create pull requests (needs Code: Read & write)';

export type RawPr = {
  pullRequestId: number;
  status: 'active' | 'completed' | 'abandoned';
  isDraft: boolean;
};

/** An active pull request as the list API returns it; only the fields Home reads. */
export type RawHomePr = {
  pullRequestId?: number;
  title?: string;
  creationDate?: string;
  isDraft?: boolean;
  mergeStatus?: string;
  repository?: { name?: string };
  createdBy?: { id?: string; displayName?: string };
  reviewers?: { id?: string; vote?: number; isContainer?: boolean }[];
};

type Json = Record<string, unknown>;
type RawWorkItem = { id: number; fields: Json; _links?: Json };
type RawState = { name?: string; color?: string; category?: string };

/** The estimate fields of a work item in hours, null when unset. */
const estimatesOf = (f: Json) => ({
  originalEstimate: hoursOf(f[ORIGINAL_ESTIMATE]),
  remainingWork: hoursOf(f[REMAINING_WORK]),
  completedWork: hoursOf(f[COMPLETED_WORK]),
});

const prPath = (project: string, repositoryId: string) =>
  `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests`;

const PR_STATUSES: readonly RawPr['status'][] = [
  'active',
  'completed',
  'abandoned',
];

/** Azure DevOps answers are not trusted as is: an unknown status reads as active, a missing isDraft as false. */
function toRawPr(data: unknown, path: string): RawPr {
  const d = (data ?? {}) as Json;
  if (typeof d.pullRequestId !== 'number')
    throw new AdoError(
      'http',
      path,
      'Azure DevOps returned a pull request without a pull request id',
    );
  return {
    pullRequestId: d.pullRequestId,
    status: PR_STATUSES.includes(d.status as RawPr['status'])
      ? (d.status as RawPr['status'])
      : 'active',
    isDraft: d.isDraft === true,
  };
}

/** Read calls and three write calls (work item fields, comment, type field listing) against one Azure DevOps organization. The token provider is called per request so a re-entered PAT takes effect immediately. */
export class AdoClient {
  constructor(
    private readonly organizationUrl: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 15000;
  }

  private unreachable(path: string, e: unknown): AdoError {
    const timedOut =
      e instanceof Error &&
      (e.name === 'TimeoutError' || e.name === 'AbortError');
    return new AdoError(
      'unreachable',
      path,
      timedOut
        ? `Azure DevOps did not answer within ${this.timeoutMs / 1000} s`
        : `Could not reach ${this.organizationUrl}: ${errorMessage(e)}`,
    );
  }

  async verify(
    project: string,
  ): Promise<{ user: string; uniqueName: string | null }> {
    const who = await this.whoAmI();
    await this.request<Json>(
      `/_apis/projects/${encodeURIComponent(project)}?${API}`,
    );
    return who;
  }

  /** The user the token belongs to, without checking any project. */
  async whoAmI(): Promise<{ user: string; uniqueName: string | null }> {
    const auth = await this.connectionData();
    const user =
      (auth?.providerDisplayName as string | undefined) ?? 'unknown user';
    const account = (
      (auth?.properties as Json | undefined)?.Account as Json | undefined
    )?.$value;
    return {
      user,
      uniqueName: typeof account === 'string' && account ? account : null,
    };
  }

  /** The organization's projects the token can see (needs Project and Team: Read). */
  async projects(): Promise<{ id: string; name: string }[]> {
    const data = await this.request<{
      value?: { id?: unknown; name?: unknown }[];
    }>(`/_apis/projects?$top=1000&${API}`);
    return (data.value ?? []).flatMap((p) =>
      typeof p.id === 'string' && p.id && typeof p.name === 'string' && p.name
        ? [{ id: p.id, name: p.name }]
        : [],
    );
  }

  async currentIteration(
    project: string,
    team?: string,
  ): Promise<SprintIteration | null> {
    return (
      (await this.teamIterations(project, team, '$timeframe=current&'))[0] ??
      null
    );
  }

  /** Every iteration of the team (the project's default team without one), in ADO's order. */
  async iterations(project: string, team?: string): Promise<SprintIteration[]> {
    return this.teamIterations(project, team, '');
  }

  /**
   * The sprints of every team of the project I am a member of, each tagged with its team, by start date. With fewer
   * than two teams, or when my teams cannot be read, the default team's list without team tags. A team whose sprints
   * fail to load is left out; when all fail, the first error is thrown.
   */
  async allIterations(project: string): Promise<SprintIteration[]> {
    const teams = await this.myTeams(project).catch(() => []);
    if (teams.length < 2) return this.iterations(project);
    const results = await Promise.allSettled(
      teams.map((t) => this.iterations(project, t.name)),
    );
    if (results.every((r) => r.status === 'rejected'))
      throw (results[0] as PromiseRejectedResult).reason;
    const seen = new Set<string>();
    const list = results.flatMap((r, n) => {
      if (r.status === 'rejected') return [];
      const team = teams[n];
      return r.value.flatMap((i) => {
        const key = `${team.id}|${i.id}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ ...i, team }];
      });
    });
    return list.sort(
      (a, b) =>
        Number(a.startDate === null) - Number(b.startDate === null) ||
        (a.startDate ?? '').localeCompare(b.startDate ?? '') ||
        a.name.localeCompare(b.name) ||
        a.team.name.localeCompare(b.team.name),
    );
  }

  private async teamIterations(
    project: string,
    team: string | undefined,
    filter: string,
  ): Promise<SprintIteration[]> {
    const scope = team
      ? `${encodeURIComponent(project)}/${encodeURIComponent(team)}`
      : encodeURIComponent(project);
    const data = await this.request<{
      value?: {
        id: string;
        name: string;
        path: string;
        attributes?: {
          startDate?: string | null;
          finishDate?: string | null;
          timeFrame?: unknown;
        };
      }[];
    }>(`/${scope}/_apis/work/teamsettings/iterations?${filter}${API}`);
    return (data.value ?? []).map((i) => {
      const timeframe = i.attributes?.timeFrame;
      return {
        id: i.id,
        path: i.path,
        name: i.name,
        startDate: i.attributes?.startDate ?? null,
        finishDate: i.attributes?.finishDate ?? null,
        ...(timeframe === 'past' ||
        timeframe === 'current' ||
        timeframe === 'future'
          ? { timeframe }
          : {}),
      };
    });
  }

  /** The id of the user the token belongs to. */
  async me(): Promise<string> {
    const id = (await this.connectionData())?.id;
    if (typeof id !== 'string' || !id)
      throw new AdoError(
        'http',
        '/_apis/connectionData',
        'Azure DevOps did not say who the token belongs to',
      );
    return id;
  }

  /** The user the token belongs to, as connectionData describes it. */
  private async connectionData(): Promise<Json | undefined> {
    const data = await this.request<Json>(
      '/_apis/connectionData?api-version=7.1-preview',
    );
    return data.authenticatedUser as Json | undefined;
  }

  /** The project's teams the token's user is a member of. */
  async myTeams(project: string): Promise<{ id: string; name: string }[]> {
    const data = await this.request<{
      value?: { id?: string; name?: string }[];
    }>(
      `/_apis/projects/${encodeURIComponent(project)}/teams?$mine=true&${API}`,
    );
    return (data.value ?? []).flatMap((t) =>
      t.id && t.name ? [{ id: t.id, name: t.name }] : [],
    );
  }

  /** Ids of open and closed work items assigned to me in any of the iteration paths, at most 200. */
  async assignedInIterations(
    project: string,
    paths: string[],
  ): Promise<number[]> {
    if (paths.length === 0) return [];
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.IterationPath] IN (${paths.map(wiqlString).join(', ')}) ORDER BY [System.Id]`;
    return (await this.wiqlIds(project, query)).slice(0, BATCH);
  }

  /** Ids of the work items a WIQL query matches, in the query's order. */
  private async wiqlIds(project: string, query: string): Promise<number[]> {
    const result = await this.send<{ workItems?: { id: number }[] }>(
      'POST',
      `/${encodeURIComponent(project)}/_apis/wit/wiql?${API}`,
      { query },
    );
    return (result.workItems ?? []).map((w) => w.id);
  }

  /** Active pull requests in the project where the identity is a reviewer, or that it created. */
  async activePullRequests(
    project: string,
    criteria: { reviewerId: string } | { creatorId: string },
  ): Promise<RawHomePr[]> {
    const filter =
      'reviewerId' in criteria
        ? `searchCriteria.reviewerId=${encodeURIComponent(criteria.reviewerId)}`
        : `searchCriteria.creatorId=${encodeURIComponent(criteria.creatorId)}`;
    const data = await this.request<{ value?: RawHomePr[] }>(
      `/${encodeURIComponent(project)}/_apis/git/pullrequests?${filter}&searchCriteria.status=active&$top=100&${API}`,
      {},
      { code: true },
    );
    return data.value ?? [];
  }

  /**
   * The sprint backlog of the team (the project's default team without one), in backlog order: top-level entries have no source, children
   * name their parent. Verified live (2026-10-15): after reordering through `iterations/{id}/workitemsorder`, this
   * API returns items by their new StackRank, not by id, so no client-side sort is needed.
   */
  async iterationWorkItems(
    project: string,
    iterationId: string,
    team?: string,
  ): Promise<SprintRelation[]> {
    const scope = team
      ? `${encodeURIComponent(project)}/${encodeURIComponent(team)}`
      : encodeURIComponent(project);
    const data = await this.request<{ workItemRelations?: SprintRelation[] }>(
      `/${scope}/_apis/work/teamsettings/iterations/${encodeURIComponent(iterationId)}/workitems?${API}`,
    );
    return (data.workItemRelations ?? []).filter(
      (r) => typeof r?.target?.id === 'number',
    );
  }

  /**
   * A sprint as grid rows: the one with `iterationId` among the team's sprints (the default team's without one), else
   * the default team's current one. No iteration when the project has no current sprint or the chosen one is gone.
   */
  async sprint(
    project: string,
    iterationId?: string,
    team?: string,
  ): Promise<Sprint> {
    const scope = iterationId ? team : undefined;
    const iteration = iterationId
      ? ((await this.iterations(project, scope)).find(
          (i) => i.id === iterationId,
        ) ?? null)
      : await this.currentIteration(project);
    if (!iteration) return { iteration: null, rows: [] };
    const relations = await this.iterationWorkItems(
      project,
      iteration.id,
      scope,
    );
    const ids = [...new Set(relations.map((r) => r.target.id))];
    const items = await this.workItems(project, ids);
    return { iteration, rows: buildSprintTree(relations, items) };
  }

  /** Work items by id with the picker's fields plus the estimate fields, in chunks of 200. Unreadable ids are left out. */
  async workItems(project: string, ids: number[]): Promise<SprintItem[]> {
    const items = await this.fetchWorkItems(ids, [
      ...FIELDS,
      ...ESTIMATE_FIELDS,
    ]);
    return items.map((w) => ({
      ...this.summary(project, w),
      ...estimatesOf(w.fields),
    }));
  }

  /** Work items by id with the given fields, in chunks of 200 and in the order of `ids`. Unreadable ids are left out. */
  private async fetchWorkItems(
    ids: number[],
    fields: string[],
  ): Promise<RawWorkItem[]> {
    const out: RawWorkItem[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const batch = await this.request<{ value?: (RawWorkItem | null)[] }>(
        `/_apis/wit/workitems?ids=${chunk.join(',')}&fields=${fields.join(',')}&errorPolicy=omit&${API}`,
      );
      const byId = new Map(
        (batch.value ?? []).flatMap((w) => (w ? [[w.id, w] as const] : [])),
      );
      for (const id of chunk) {
        const w = byId.get(id);
        if (w) out.push(w);
      }
    }
    return out;
  }

  private summary(project: string, w: RawWorkItem): WorkItemSummary {
    const f = w.fields;
    const assigned = f['System.AssignedTo'] as Json | string | undefined;
    const html = ((w._links as Json | undefined)?.html as Json | undefined)
      ?.href as string | undefined;
    return {
      id: String(w.id),
      type: String(f['System.WorkItemType'] ?? ''),
      title: String(f['System.Title'] ?? ''),
      state: String(f['System.State'] ?? ''),
      areaPath: String(f['System.AreaPath'] ?? ''),
      iterationPath: String(f['System.IterationPath'] ?? ''),
      assignedTo:
        typeof assigned === 'string'
          ? assigned
          : ((assigned?.displayName as string | undefined) ?? null),
      url:
        html ??
        `${this.organizationUrl}/${encodeURIComponent(project)}/_workitems/edit/${w.id}`,
    };
  }

  async searchWorkItems(opts: {
    project: string;
    scope: 'sprint' | 'mine';
    text: string;
    iterationPath: string | null;
  }): Promise<WorkItemSummary[]> {
    const ids = (await this.wiqlIds(opts.project, buildWiql(opts))).slice(
      0,
      MAX_RESULTS,
    );
    const items = await this.fetchWorkItems(ids, FIELDS);
    return items.map((w) => this.summary(opts.project, w));
  }

  async workItemTypeFields(
    project: string,
  ): Promise<{ type: string; fields: string[] }[]> {
    const data = await this.request<{
      value?: {
        name: string;
        isDisabled?: boolean;
        fields?: { referenceName: string }[];
      }[];
    }>(`/${encodeURIComponent(project)}/_apis/wit/workitemtypes?${API}`);
    return (data.value ?? [])
      .filter((t) => !t.isDisabled)
      .map((t) => ({
        type: t.name,
        fields: (t.fields ?? []).map((f) => f.referenceName),
      }));
  }

  /** The enabled work item types with their color, icon URL and states (from the list, or per type when the list leaves them out). */
  async workItemTypes(
    project: string,
  ): Promise<(Omit<WorkItemTypeMeta, 'icon'> & { iconUrl: string | null })[]> {
    const data = await this.request<{
      value?: {
        name: string;
        color?: string;
        isDisabled?: boolean;
        icon?: { url?: string };
        states?: RawState[];
      }[];
    }>(`/${encodeURIComponent(project)}/_apis/wit/workitemtypes?${API}`);
    const states = (raw: RawState[]): WorkItemStateMeta[] =>
      raw.flatMap((st) =>
        st.name
          ? [
              {
                name: st.name,
                color: hexColor(st.color),
                category: st.category ?? null,
              },
            ]
          : [],
      );
    return Promise.all(
      (data.value ?? [])
        .filter((t) => !t.isDisabled)
        .map(async (t) => ({
          name: t.name,
          color: hexColor(t.color),
          iconUrl: t.icon?.url ?? null,
          states: t.states
            ? states(t.states)
            : await this.rawStates(project, t.name)
                .then(states)
                .catch(() => []),
        })),
    );
  }

  /**
   * Downloads a type icon (SVG or PNG, at most 256 KB) and returns it as a data URL, or null. The PAT goes only to
   * URLs under the organization itself (`dev.azure.com/<org>/...`, or the whole `<org>.visualstudio.com` host);
   * a refused or failed authenticated fetch is retried without it, as ADO serves the icons anonymously too.
   */
  async iconDataUrl(iconUrl: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(iconUrl);
    } catch {
      return null;
    }
    const org = new URL(this.organizationUrl);
    const orgPath = org.pathname.replace(/\/+$/, '');
    const ownOrg =
      url.host === org.host &&
      url.protocol === org.protocol &&
      (orgPath === '' || url.pathname.startsWith(`${orgPath}/`));
    if (url.protocol !== 'https:' && !ownOrg) return null;
    const get = async (auth: boolean): Promise<string | null> => {
      const abort = new AbortController();
      try {
        const headers: Record<string, string> = {
          accept: 'image/svg+xml, image/png',
        };
        if (auth) headers.authorization = await this.authHeader();
        const res = await this.fetchImpl(url.href, {
          signal: AbortSignal.any([
            abort.signal,
            AbortSignal.timeout(this.timeoutMs),
          ]),
          // Never carry the PAT along a redirect.
          redirect: auth ? 'manual' : 'follow',
          headers,
        });
        const type = (res.headers.get('content-type') ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (
          !res.ok ||
          !ICON_TYPES.has(type) ||
          !res.body ||
          declared > MAX_ICON_BYTES
        ) {
          abort.abort();
          return null;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_ICON_BYTES) {
            abort.abort();
            await reader.cancel().catch(() => undefined);
            return null;
          }
          chunks.push(value);
        }
        if (size === 0) return null;
        return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
      } catch {
        abort.abort();
        return null;
      }
    };
    return (ownOrg ? await get(true) : null) ?? get(false);
  }

  async updateWorkItemFields(
    id: number,
    fields: Record<string, number>,
  ): Promise<void> {
    await this.send<Json>(
      'PATCH',
      `/_apis/wit/workitems/${id}?${API}`,
      Object.entries(fields).map(([name, value]) => ({
        op: 'add',
        path: `/fields/${name}`,
        value,
      })),
      { write: true },
      'application/json-patch+json',
    );
  }

  async addComment(
    project: string,
    id: number,
    markdown: string,
  ): Promise<{ id: number }> {
    const data = await this.send<{ id: number }>(
      'POST',
      `/${encodeURIComponent(project)}/_apis/wit/workItems/${id}/comments?format=markdown&api-version=7.1-preview.4`,
      { text: markdown },
      { write: true },
    );
    return { id: data.id };
  }

  /**
   * Every field, the linked work items and the newest 200 comments (oldest first) of a work item, for task.md.
   * A failing comments call leaves the comments out rather than failing the whole read.
   */
  async workItemDetails(id: number): Promise<WorkItemDetails> {
    const data = await this.request<{
      fields?: Json;
      relations?: { url?: string; attributes?: { name?: unknown } }[];
      _links?: { html?: { href?: unknown } };
    }>(`/_apis/wit/workitems/${id}?$expand=all&${API}`);
    const fields = data.fields ?? {};
    const href = data._links?.html?.href;
    const links = (data.relations ?? []).flatMap((r) => {
      const linked = /\/workItems\/(\d+)$/i.exec(r.url ?? '');
      const name = r.attributes?.name;
      return linked && typeof name === 'string'
        ? [{ name, id: linked[1] }]
        : [];
    });
    const project = fields['System.TeamProject'];
    let comments: WorkItemDetails['comments'] = [];
    if (typeof project === 'string' && project)
      try {
        const c = await this.request<{
          comments?: {
            text?: unknown;
            format?: unknown;
            createdBy?: { displayName?: unknown };
            createdDate?: unknown;
          }[];
        }>(
          `/${encodeURIComponent(project)}/_apis/wit/workItems/${id}/comments?format=markdown&order=desc&$top=200&api-version=7.1-preview.4`,
        );
        comments = (c.comments ?? [])
          .flatMap((x) =>
            typeof x.text === 'string'
              ? [
                  {
                    author: String(x.createdBy?.displayName ?? 'Someone'),
                    createdDate: String(x.createdDate ?? ''),
                    text: x.text,
                    html: x.format !== 'markdown',
                  },
                ]
              : [],
          )
          .reverse();
      } catch {
        comments = [];
      }
    return {
      fields,
      url: typeof href === 'string' ? href : null,
      links,
      comments,
    };
  }

  /** Type and estimate fields (hours, null when unset) of a work item. */
  async workItemEstimate(id: number): Promise<{
    type: string;
    originalEstimate: number | null;
    remainingWork: number | null;
    completedWork: number | null;
  }> {
    const data = await this.request<{ fields?: Json }>(
      `/_apis/wit/workitems/${id}?fields=${['System.WorkItemType', ...ESTIMATE_FIELDS].join(',')}&${API}`,
    );
    const f = data.fields ?? {};
    return { type: String(f['System.WorkItemType'] ?? ''), ...estimatesOf(f) };
  }

  /** Type, state and assignee (unique name, else display name) of a work item. */
  async workItemForStart(
    id: number,
  ): Promise<{ type: string; state: string; assignedTo: string | null }> {
    const data = await this.request<{ fields?: Json }>(
      `/_apis/wit/workitems/${id}?fields=System.WorkItemType,System.State,System.AssignedTo&${API}`,
    );
    const f = data.fields ?? {};
    const a = f['System.AssignedTo'] as Json | string | undefined;
    const name =
      typeof a === 'string' ? a : (a?.uniqueName ?? a?.displayName ?? null);
    return {
      type: String(f['System.WorkItemType'] ?? ''),
      state: String(f['System.State'] ?? ''),
      assignedTo: typeof name === 'string' && name ? name : null,
    };
  }

  async typeStates(
    project: string,
    type: string,
  ): Promise<{ name: string; category: string | null }[]> {
    return (await this.rawStates(project, type)).flatMap((s) =>
      s.name ? [{ name: s.name, category: s.category ?? null }] : [],
    );
  }

  private async rawStates(project: string, type: string): Promise<RawState[]> {
    const data = await this.request<{ value?: RawState[] }>(
      `/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?${API}`,
    );
    return data.value ?? [];
  }

  async updateWorkItem(
    id: number,
    change: { state?: string; assignedTo?: string },
  ): Promise<void> {
    const ops = [
      ...(change.state
        ? [{ op: 'add', path: '/fields/System.State', value: change.state }]
        : []),
      ...(change.assignedTo
        ? [
            {
              op: 'add',
              path: '/fields/System.AssignedTo',
              value: change.assignedTo,
            },
          ]
        : []),
    ];
    if (ops.length === 0) return;
    await this.send<Json>(
      'PATCH',
      `/_apis/wit/workitems/${id}?${API}`,
      ops,
      { write: true },
      'application/json-patch+json',
    );
  }

  async repositoryId(project: string, repo: string): Promise<string> {
    const data = await this.request<{ id: string }>(
      `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}?${API}`,
      {},
      { code: true },
    );
    return data.id;
  }

  async findActivePullRequest(
    project: string,
    repositoryId: string,
    branch: string,
  ): Promise<RawPr | null> {
    const path = prPath(project, repositoryId);
    const data = await this.request<{ value?: unknown[] }>(
      `${path}?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}&searchCriteria.status=active&${API}`,
      {},
      { code: true },
    );
    const first = (data.value ?? [])[0];
    return first === undefined ? null : toRawPr(first, path);
  }

  async createPullRequest(
    project: string,
    repositoryId: string,
    input: {
      source: string;
      target: string;
      title: string;
      description: string;
      workItemId: number | null;
    },
  ): Promise<RawPr> {
    const path = prPath(project, repositoryId);
    const data = await this.send<unknown>(
      'POST',
      `${path}?${API}`,
      {
        sourceRefName: `refs/heads/${input.source}`,
        targetRefName: `refs/heads/${input.target}`,
        title: input.title,
        description: input.description,
        isDraft: true,
        workItemRefs: input.workItemId
          ? [{ id: String(input.workItemId) }]
          : [],
      },
      { write: true, code: true },
    );
    return toRawPr(data, path);
  }

  async pullRequest(
    project: string,
    repositoryId: string,
    id: number,
  ): Promise<RawPr> {
    const path = `${prPath(project, repositoryId)}/${id}`;
    const data = await this.request<unknown>(
      `${path}?${API}`,
      {},
      { code: true },
    );
    return toRawPr(data, path);
  }

  private async authHeader(): Promise<string> {
    return `Basic ${Buffer.from(`:${await this.token()}`).toString('base64')}`;
  }

  /** A request with a JSON body. */
  private send<T>(
    method: string,
    path: string,
    body: unknown,
    opts: { write?: boolean; code?: boolean } = {},
    contentType = 'application/json',
  ): Promise<T> {
    return this.request<T>(
      path,
      {
        method,
        headers: { 'content-type': contentType },
        body: JSON.stringify(body),
      },
      opts,
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    opts: { write?: boolean; code?: boolean; retried?: boolean } = {},
  ): Promise<T> {
    const url = `${this.organizationUrl}${path}`;
    const authorization = await this.authHeader();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'manual',
        headers: {
          accept: 'application/json',
          ...init.headers,
          authorization,
        },
      });
    } catch (e) {
      throw this.unreachable(path, e);
    }
    if (res.status === 429 && !opts.retried) {
      const header = Number(res.headers.get('retry-after') ?? '1');
      const wait = Math.min(10, Math.max(0, Number.isNaN(header) ? 1 : header));
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.request<T>(path, init, { ...opts, retried: true });
    }
    const redirected =
      (res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect';
    const html =
      res.ok && (res.headers.get('content-type') ?? '').startsWith('text/html');
    if (
      res.status === 401 ||
      res.status === 203 ||
      res.status === 403 ||
      redirected ||
      html
    ) {
      throw new AdoError(
        'unauthorized',
        path,
        (res.status === 401 || res.status === 403) && (opts.code || opts.write)
          ? opts.code
            ? opts.write
              ? CODE_WRITE_DENIED
              : CODE_READ_DENIED
            : WRITE_DENIED
          : 'Azure DevOps rejected the token (check that it is valid and has Work Items read scope)',
        res.status,
      );
    }
    if (res.status === 404)
      throw new AdoError(
        'not-found',
        path,
        `Not found: ${path.split('?')[0]}`,
        404,
      );
    let raw: string;
    try {
      raw = await res.text();
    } catch (e) {
      throw this.unreachable(path, e);
    }
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    if (!res.ok) {
      let message: unknown;
      try {
        message = (JSON.parse(text) as Json).message;
      } catch {
        message = undefined;
      }
      throw new AdoError(
        'http',
        path,
        typeof message === 'string' && message
          ? `Azure DevOps returned ${res.status}: ${message}`
          : `Azure DevOps returned ${res.status} for ${path.split('?')[0]}`,
        res.status,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AdoError(
        'http',
        path,
        `Azure DevOps returned an unreadable response for ${path.split('?')[0]}`,
        res.status,
      );
    }
  }
}
