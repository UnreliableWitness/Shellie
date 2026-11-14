import type {
  AttentionEntry,
  AttentionSignal,
  AttentionSnapshot,
  AttentionState,
  AttentionView,
} from '../../shared/attention';
import type { TerminalDef } from '../../shared/types';
import { AttentionTracker } from './AttentionTracker';
import { OscScanner, PROBE_REPLY, programStatusSignal } from './OscScanner';

const BELL_GAP_MS = 10_000;

export type HubTerminal = {
  taskId: string;
  taskTitle: string;
  label: string;
  kind: TerminalDef['kind'];
};

type HubDeps = {
  now: () => number;
  write: (terminalId: string, data: string) => void;
  terminal: (terminalId: string) => HubTerminal | null;
  notifyOnDone: () => boolean;
  show: (n: { title: string; body: string; onClick: () => void }) => {
    close(): void;
  };
  setBadgeCount: (n: number) => void;
  changed: (snapshot: AttentionSnapshot) => void;
  open: (taskId: string, terminalId: string) => void;
  /** A program's own status report (OSC 7501), for whoever else needs to know it is busy. */
  status?: (terminalId: string, state: AttentionState) => void;
  /** Every agent state report, Claude's (OSC 7501) and OpenCode's (plugin) alike, muted or not. */
  observed?: (terminalId: string, state: AttentionState) => void;
};

/** The notification text for a terminal's tab label and what it waits for. */
export function notificationBody(label: string, e: AttentionEntry): string {
  const head =
    e.reason === 'done'
      ? `${label} finished`
      : e.kind === 'permission'
        ? `${label} needs permission`
        : e.kind === 'question'
          ? `${label} has a question`
          : e.kind === 'bell'
            ? `${label} rang the bell`
            : `${label} is waiting for you`;
  return e.message ? `${head}: ${e.message}` : head;
}

/**
 * Main's side of attention: reads every terminal's output (Claude's OSC 7501 status, bells), takes the OpenCode
 * plugin's signals from the receiver, and turns the tracker's decisions into notifications and the Dock count.
 */
export class AttentionHub {
  private readonly scanners = new Map<string, OscScanner>();
  /** Terminals that reported OSC 7501 status: their bells are not a signal. */
  private readonly reporting = new Set<string>();
  private readonly lastBell = new Map<string, number>();
  /** Terminals whose next finished turn is Shellie's own request (the PR draft): it neither notifies nor badges. */
  private readonly muted = new Set<string>();
  private readonly shown = new Map<string, { close(): void }>();
  private readonly tracker: AttentionTracker;

  constructor(private readonly d: HubDeps) {
    this.tracker = new AttentionTracker({
      now: d.now,
      notifyOnDone: d.notifyOnDone,
      onNotify: (id, e) => this.notify(id, e),
      onDismiss: (id) => this.close(id),
      onChange: (snap) => {
        d.setBadgeCount(Object.keys(snap).length);
        d.changed(snap);
      },
    });
  }

  snapshot(): AttentionSnapshot {
    return this.tracker.snapshot();
  }

  data(terminalId: string, chunk: string): void {
    let scanner = this.scanners.get(terminalId);
    if (!scanner) {
      scanner = new OscScanner();
      this.scanners.set(terminalId, scanner);
    }
    for (const ev of scanner.push(chunk)) {
      if (ev.type === 'probe') {
        try {
          this.d.write(terminalId, PROBE_REPLY);
        } catch {
          // The terminal went away between its output and the reply.
        }
      } else if (ev.type === 'status') {
        this.reporting.add(terminalId);
        const s = programStatusSignal(ev.fields);
        if (s) {
          this.d.status?.(terminalId, s.state);
          this.pass(terminalId, s);
        }
      } else this.bell(terminalId);
    }
  }

  /** A signal from the receiver; false when the terminal is unknown. */
  signal(terminalId: string, s: AttentionSignal): boolean {
    if (!this.d.terminal(terminalId)) return false;
    this.pass(terminalId, s);
    return true;
  }

  /**
   * The next `done` or `idle` of the terminal ends a turn Shellie asked for: it reaches the tracker as `idle`, so it
   * clears what the turn raised (a permission prompt) without a notification or badge of its own.
   */
  muteNextDone(terminalId: string): void {
    this.muted.add(terminalId);
  }

  unmute(terminalId: string): void {
    this.muted.delete(terminalId);
  }

  private pass(terminalId: string, s: AttentionSignal): void {
    this.d.observed?.(terminalId, s.state);
    if (
      this.muted.has(terminalId) &&
      (s.state === 'done' || s.state === 'idle')
    ) {
      this.muted.delete(terminalId);
      this.tracker.signal(terminalId, { state: 'idle' });
      return;
    }
    this.tracker.signal(terminalId, s);
  }

  exit(terminalId: string): void {
    this.muted.delete(terminalId);
    this.scanners.delete(terminalId);
    this.reporting.delete(terminalId);
    this.lastBell.delete(terminalId);
    this.tracker.forget(terminalId);
  }

  /** Forgets every terminal not in `ids` (closed tabs, finished tasks: kill emits no exit). */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.scanners.keys()) if (!ids.has(id)) this.exit(id);
    for (const id of this.muted) if (!ids.has(id)) this.muted.delete(id);
    this.tracker.retain(ids);
  }

  setFocused(focused: boolean): void {
    this.tracker.setFocused(focused);
  }

  setView(view: AttentionView): void {
    this.tracker.setView(view);
  }

  private bell(terminalId: string): void {
    if (this.reporting.has(terminalId)) return;
    const t = this.d.terminal(terminalId);
    if (!t || t.kind === 'opencode') return;
    const now = this.d.now();
    const last = this.lastBell.get(terminalId);
    if (last !== undefined && now - last < BELL_GAP_MS) return;
    this.lastBell.set(terminalId, now);
    this.tracker.signal(terminalId, { state: 'blocked', kind: 'bell' });
  }

  private notify(terminalId: string, e: AttentionEntry): void {
    const t = this.d.terminal(terminalId);
    if (!t) return;
    this.close(terminalId);
    this.shown.set(
      terminalId,
      this.d.show({
        title: t.taskTitle,
        body: notificationBody(t.label, e),
        onClick: () => this.d.open(t.taskId, terminalId),
      }),
    );
  }

  private close(terminalId: string): void {
    this.shown.get(terminalId)?.close();
    this.shown.delete(terminalId);
  }
}
