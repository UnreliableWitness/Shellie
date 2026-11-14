import type { AttentionState } from '../../shared/attention';

// eslint-disable-next-line no-control-regex -- matching escape sequences is the point
const REPORTS = /\x1b\[[IO]|\x1b\[<[0-9;]*[Mm]|\x1b\[M[\s\S]{3}/g;

/**
 * Whether the prompt box may hold something after the developer's input `data`. Stricter than the theme restart's
 * rule: any key since the last Enter or Ctrl+C counts, arrows too (Up recalls an earlier prompt, Esc opens a picker),
 * so Shellie never types into a box that holds anything. Only focus and mouse reports are not keys.
 */
export function pendingAfter(pending: boolean, data: string): boolean {
  const keys = data.replace(REPORTS, '');
  if (!keys) return pending;
  const end = Math.max(keys.lastIndexOf('\r'), keys.lastIndexOf('\x03'));
  if (end < 0) return true;
  return keys.length > end + 1;
}

type Tab = {
  /** The agent's last reported state since the tab (re)started; null when it reported none yet (a resumed tab). */
  state: AttentionState | null;
  lastOutput: number;
  /** Something was typed or pasted since the last Enter: the prompt box may hold text. */
  typed: boolean;
};

export type TabView = {
  state: AttentionState | null;
  typed: boolean;
  /** How long the tab printed nothing, in ms. */
  quietFor: number;
};

/**
 * What every agent tab is doing, so Shellie can tell when typing into one is safe (the PR draft asks the task's tab):
 * the agent's last state from either path (Claude's OSC 7501, OpenCode's plugin), when it last printed, and whether
 * the developer left text in its prompt box. A tab that starts again starts clean.
 */
export class TabActivity {
  private readonly tabs = new Map<string, Tab>();
  private readonly listeners = new Set<
    (id: string, state: AttentionState) => void
  >();

  constructor(private readonly now: () => number) {}

  private fresh(): Tab {
    return { state: null, lastOutput: this.now(), typed: false };
  }

  spawned(id: string): void {
    this.tabs.set(id, this.fresh());
  }

  private tab(id: string): Tab {
    let t = this.tabs.get(id);
    if (!t) this.tabs.set(id, (t = this.fresh()));
    return t;
  }

  /** Output of any terminal; only agent tabs (started through `spawned`) are kept. */
  output(id: string): void {
    const t = this.tabs.get(id);
    if (t) t.lastOutput = this.now();
  }

  status(id: string, state: AttentionState): void {
    const t = this.tab(id);
    t.state = state;
    for (const l of this.listeners) l(id, state);
  }

  input(id: string, data: string): void {
    const t = this.tabs.get(id);
    if (t) t.typed = pendingAfter(t.typed, data);
  }

  exit(id: string): void {
    this.tabs.delete(id);
  }

  view(id: string): TabView | null {
    const t = this.tabs.get(id);
    if (!t) return null;
    return {
      state: t.state,
      typed: t.typed,
      quietFor: this.now() - t.lastOutput,
    };
  }

  /** Calls `listener` on every state report; returns the unsubscribe. */
  onState(listener: (id: string, state: AttentionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
