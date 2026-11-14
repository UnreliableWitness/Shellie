import {
  PR_FALLBACK_NOTE,
  type PrDraft,
  type PrFallbackReason,
} from '../../shared/prDraft';
import type { AskTabResult } from './askTab';

export type PrWriter = 'claude' | 'opencode';

/** What `pick` found: a tab to ask (and how), or why there is none. */
export type PickResult =
  | {
      tab: { id: string; label: string };
      agent: PrWriter;
      ask: (
        signal: AbortSignal,
        onBlocked: (blocked: boolean) => void,
      ) => Promise<AskTabResult>;
    }
  | { reason: PrFallbackReason };

export type HeadlessResult =
  | { text: string; agent: PrWriter }
  | { error: string; reason: string; agent: PrWriter | null };

export type PrDraftsDeps = {
  pick(taskId: string, workspaceId: string): Promise<PickResult>;
  headless(
    taskId: string,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<HeadlessResult>;
  /** The written text as the PR gets it (tidied, stored secrets masked); empty when nothing is left. */
  finish(taskId: string, workspaceId: string, text: string): string;
  changed(taskId: string, workspaceId: string, draft: PrDraft): void;
  event(
    name: string,
    props: Record<string, string | boolean>,
    measures: Record<string, number>,
  ): void;
  now(): number;
};

const blank = (): PrDraft => ({
  status: 'writing',
  source: null,
  tab: null,
  text: '',
  error: null,
  note: null,
});

const key = (taskId: string, workspaceId: string) =>
  `${taskId}\0${workspaceId}`;

/**
 * The Finish page's PR drafts, kept in main so leaving the page (to look at the tab being asked) loses nothing. A
 * draft first asks the task's agent tab, else (or when that gives nothing) a headless run writes it. One task's
 * drafts are written one after the other, so a tab is never asked twice at once; Skip and Write again stop the one
 * running (a late answer is ignored).
 */
export class PrDrafts {
  private readonly drafts = new Map<string, PrDraft>();
  private readonly running = new Map<string, AbortController>();
  /** Per task, the end of the last queued write. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly d: PrDraftsDeps) {}

  /** The task's drafts by workspace id. */
  get(taskId: string): Record<string, PrDraft> {
    const out: Record<string, PrDraft> = {};
    const prefix = `${taskId}\0`;
    for (const [k, v] of this.drafts)
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = { ...v };
    return out;
  }

  private set(taskId: string, workspaceId: string, draft: PrDraft): PrDraft {
    this.drafts.set(key(taskId, workspaceId), draft);
    this.d.changed(taskId, workspaceId, { ...draft });
    return draft;
  }

  /** Writes (or writes again) a draft; resolves with it once written, skipped or failed. */
  write(taskId: string, workspaceId: string): Promise<PrDraft> {
    const k = key(taskId, workspaceId);
    this.running.get(k)?.abort();
    const ac = new AbortController();
    this.running.set(k, ac);
    this.set(taskId, workspaceId, blank());
    return this.run(taskId, workspaceId, ac.signal).finally(() => {
      if (this.running.get(k) === ac) this.running.delete(k);
    });
  }

  /** Runs `fn` after the task's earlier queued ones: a tab is asked for one repo at a time. */
  private serial<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.queues.get(taskId) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(fn);
    this.queues.set(taskId, run);
    void run
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(taskId) === run) this.queues.delete(taskId);
      });
    return run;
  }

  /** The written text as the PR gets it; empty when finishing it failed. */
  private finished(taskId: string, ws: string, text: string): string {
    try {
      return this.d.finish(taskId, ws, text);
    } catch {
      return '';
    }
  }

  skip(taskId: string, workspaceId: string): void {
    const k = key(taskId, workspaceId);
    this.running.get(k)?.abort();
    this.running.delete(k);
    this.set(taskId, workspaceId, { ...blank(), status: 'skipped' });
  }

  /** The developer's own text for the draft. */
  edit(taskId: string, workspaceId: string, text: string): void {
    const k = key(taskId, workspaceId);
    const d = this.drafts.get(k);
    if (
      !d ||
      d.status === 'writing' ||
      d.status === 'asking-tab' ||
      d.status === 'tab-blocked'
    )
      return;
    this.drafts.set(k, { ...d, text });
  }

  /** Drops a task's drafts (it finished or went away). */
  forget(taskId: string): void {
    const prefix = `${taskId}\0`;
    for (const [k, ac] of this.running)
      if (k.startsWith(prefix)) {
        ac.abort();
        this.running.delete(k);
      }
    for (const k of [...this.drafts.keys()])
      if (k.startsWith(prefix)) this.drafts.delete(k);
  }

  private async run(
    taskId: string,
    ws: string,
    signal: AbortSignal,
  ): Promise<PrDraft> {
    const current = () => this.drafts.get(key(taskId, ws)) ?? blank();
    if (signal.aborted) return current();
    const started = this.d.now();
    const report = (props: Record<string, string | boolean>, chars?: number) =>
      this.d.event('pr.summary', props, {
        ms: this.d.now() - started,
        ...(chars !== undefined ? { chars } : {}),
      });

    // Only asking a tab waits for the task's other repos; a headless run never does.
    const asked = await this.serial(
      taskId,
      async (): Promise<
        { draft: PrDraft } | { reason: PrFallbackReason } | { aborted: true }
      > => {
        if (signal.aborted) return { aborted: true };
        let picked: PickResult;
        try {
          picked = await this.d.pick(taskId, ws);
        } catch {
          picked = { reason: 'no-tab' };
        }
        if (signal.aborted) return { aborted: true };
        if (!('tab' in picked)) return { reason: picked.reason };
        const tab = picked.tab;
        this.set(taskId, ws, {
          ...blank(),
          status: 'asking-tab',
          source: 'tab',
          tab,
        });
        let r: AskTabResult;
        try {
          r = await picked.ask(signal, (blocked) => {
            if (signal.aborted) return;
            this.set(taskId, ws, {
              ...current(),
              status: blocked ? 'tab-blocked' : 'asking-tab',
            });
          });
        } catch {
          r = { reason: 'no-reply' };
        }
        if (signal.aborted || 'aborted' in r) return { aborted: true };
        if (!('text' in r)) return { reason: r.reason };
        const text = this.finished(taskId, ws, r.text);
        if (!text) return { reason: 'no-reply' };
        report({ ok: true, source: 'tab', agent: picked.agent }, text.length);
        return {
          draft: this.set(taskId, ws, {
            ...blank(),
            status: 'ready',
            source: 'tab',
            tab,
            text,
          }),
        };
      },
    );
    if ('aborted' in asked) return current();
    if ('draft' in asked) return asked.draft;
    const reason = asked.reason;

    const words = PR_FALLBACK_NOTE[reason];
    const note = words ? `Written without the agent tab: ${words}.` : null;
    this.set(taskId, ws, { ...blank(), source: 'headless', note });
    const h = await this.d
      .headless(taskId, ws, signal)
      .catch((e: unknown): HeadlessResult => ({
        error: e instanceof Error ? e.message : String(e),
        reason: 'failed',
        agent: null,
      }));
    if (signal.aborted) return current();
    const base = { source: 'headless', reason } as const;
    if ('text' in h) {
      const text = this.finished(taskId, ws, h.text);
      if (text) {
        report({ ok: true, ...base, agent: h.agent }, text.length);
        return this.set(taskId, ws, {
          ...blank(),
          status: 'ready',
          source: 'headless',
          text,
          note,
        });
      }
      report({ ok: false, ...base, agent: h.agent, failure: 'empty' });
      return this.set(taskId, ws, {
        ...blank(),
        status: 'failed',
        source: 'headless',
        error: `${h.agent === 'opencode' ? 'OpenCode' : 'Claude Code'} wrote nothing`,
        note,
      });
    }
    report({
      ok: false,
      ...base,
      ...(h.agent ? { agent: h.agent } : {}),
      failure: h.reason,
    });
    return this.set(taskId, ws, {
      ...blank(),
      status: 'failed',
      source: 'headless',
      error: h.error,
      note,
    });
  }
}
