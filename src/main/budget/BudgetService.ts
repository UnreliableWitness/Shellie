import type {
  AlertKind,
  BudgetRecord,
  BudgetSettings,
  Vendor,
} from '../../shared/budget';
import { budgetMonth, dayKey, VENDORS } from '../../shared/budget';
import { type BudgetView, budgetView } from '../../shared/budgetView';
import type { Task } from '../../shared/types';
import { eur } from '../../shared/text';
import { taskWorkspaces } from '../../shared/workspaces';
import { isInside } from '../paths';
import { OFFICIAL_RATES } from '../pricing/officialRates';
import { modelLabeler } from '../pricing/RateTable';
import type { BudgetStore } from './BudgetStore';
import type { ClaudeTranscriptReader } from './claudeTranscripts';
import type { OpenCodeRead } from './openCodeRemote';

const VENDOR_NAME: Record<Vendor, string> = {
  claude: 'Claude',
  copilot: 'Copilot',
};
const ALERT_TEXT: Record<AlertKind, string> = {
  at80: '80% used',
  forecastOver: 'on pace to go over',
  at100: 'used up',
};

export type BudgetServiceDeps = {
  store: BudgetStore;
  claude: { read: ClaudeTranscriptReader['read'] };
  openCode: { read: OpenCodeRead };
  settings: (v: Vendor) => BudgetSettings;
  /** Records from Shellie's own usage store: Copilot CLI requests and PR-summary runs. */
  extra: () => BudgetRecord[];
  /** Called once per pass; returns the in-Shellie test for that pass's records. */
  inShellie: () => (r: BudgetRecord) => boolean;
  now?: () => Date;
  changed: () => void;
  notify: (n: { title: string; body: string }) => void;
  telemetry?: (vendor: Vendor, kind: AlertKind) => void;
};

const label = modelLabeler(OFFICIAL_RATES);

/** Reads Claude Code, OpenCode and Shellie's own usage into the budget rollup, on a timer and on demand, and raises each budget's alerts. */
export class BudgetService {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly d: BudgetServiceDeps) {}

  private now() {
    return this.d.now?.() ?? new Date();
  }

  pass(): Promise<void> {
    this.running ??= this.run()
      .catch((err) => {
        console.warn('[budget] pass failed', err);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async run() {
    const now = this.now();
    // Keep enough history for both budgets: the start day whose previous month starts earliest.
    const monthStartDay = VENDORS.map((v) => this.d.settings(v).monthStartDay)
      .map((d) => ({ d, t: budgetMonth(now, d, -1).start.getTime() }))
      .reduce((a, b) => (b.t < a.t ? b : a)).d;
    const f = this.d.store.value;
    const claude = await this.d.claude.read(f.claudeCursors);
    let oc: { records: BudgetRecord[]; cursor: number; found: boolean };
    try {
      oc = await this.d.openCode.read(f.openCodeCursor);
    } catch (err) {
      console.warn('[budget] OpenCode database not readable this pass', err);
      oc = { records: [], cursor: f.openCodeCursor, found: f.sources.openCode };
    }
    let extra: BudgetRecord[] = [];
    try {
      extra = this.d.extra();
    } catch (err) {
      console.warn('[budget] usage store not readable this pass', err);
    }
    const changed = await this.d.store.apply({
      records: [...claude.records, ...oc.records, ...extra],
      inShellie: this.d.inShellie(),
      now,
      monthStartDay,
      claudeCursors: claude.cursors,
      openCodeCursor: oc.cursor,
      sources: { claudeCode: claude.found, openCode: oc.found },
    });
    for (const vendor of VENDORS) {
      const v = this.view(vendor, 0);
      for (const kind of v.alertsDue) {
        await this.d.store.markAlert(`${vendor}:${v.startDay}`, kind);
        this.d.notify({
          title: `${VENDOR_NAME[vendor]} budget: ${ALERT_TEXT[kind]}`,
          body: `${eur(v.spentEur)} of ${eur(v.budgetEur ?? 0)} spent${v.forecastEur !== null ? `, on pace for ${eur(v.forecastEur)}` : ''}.`,
        });
        this.d.telemetry?.(vendor, kind);
      }
    }
    if (changed) this.d.changed();
  }

  view(vendor: Vendor, monthOffset: number): BudgetView {
    const s = this.d.settings(vendor);
    const f = this.d.store.value;
    const now = this.now();
    const monthKey = dayKey(
      budgetMonth(now, s.monthStartDay, monthOffset).start,
    );
    return budgetView({
      days: f.days,
      vendor,
      settings: s,
      now,
      monthOffset,
      fired: f.alerts[`${vendor}:${monthKey}`] ?? [],
      sources: f.sources,
      scanned: f.scanned,
      label,
    });
  }

  start(intervalMs = 30_000) {
    void this.pass();
    this.timer ??= setInterval(() => void this.pass(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** In Shellie: a record from the usage store (tagged with its task), a Claude Code session one of the tasks' Claude tabs ran (or the usage store saw for a task), or OpenCode working inside a task's worktree. Returns a per-pass factory so the task list and session sets are built once per pass. */
export function inShellieFor(
  tasks: () => Task[],
  extraSessions?: () => Set<string>,
): () => (r: BudgetRecord) => boolean {
  return () => {
    const all = tasks();
    const tabs = new Set(
      all.flatMap((t) =>
        [...t.terminals, ...t.closedTerminals].flatMap((x) =>
          x.sessionId ? [x.sessionId] : [],
        ),
      ),
    );
    let extra: Set<string> | null = null;
    const worktrees = all.flatMap((t) =>
      taskWorkspaces(t).flatMap((w) =>
        w.worktreePath ? [w.worktreePath] : [],
      ),
    );
    return (r) => {
      if (r.taskId) return true;
      if (r.tool === 'claude-code') {
        if (tabs.has(r.sessionId)) return true;
        extra ??= extraSessions?.() ?? new Set();
        return extra.has(r.sessionId);
      }
      const cwd = r.cwd;
      return !!cwd && worktrees.some((w) => isInside(w, cwd));
    };
  };
}
