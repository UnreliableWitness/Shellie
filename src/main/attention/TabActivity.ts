import type { AttentionState } from '../../shared/attention';
import { unsentAfter } from '../services/ClaudeRetheme';

type Tab = {
  /** The agent's last reported state since the tab (re)started; null when it reported none yet (a resumed tab). */
  state: AttentionState | null;
  stateAt: number | null;
  lastOutput: number;
  /** Something was typed or pasted since the last Enter: the prompt box may hold text. */
  typed: boolean;
};

export type TabView = {
  state: AttentionState | null;
  stateAt: number | null;
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

  spawned(id: string): void {
    this.tabs.set(id, {
      state: null,
      stateAt: null,
      lastOutput: this.now(),
      typed: false,
    });
  }

  private tab(id: string): Tab {
    let t = this.tabs.get(id);
    if (!t) {
      t = { state: null, stateAt: null, lastOutput: this.now(), typed: false };
      this.tabs.set(id, t);
    }
    return t;
  }

  output(id: string): void {
    this.tab(id).lastOutput = this.now();
  }

  status(id: string, state: AttentionState): void {
    const t = this.tab(id);
    t.state = state;
    t.stateAt = this.now();
    for (const l of this.listeners) l(id, state);
  }

  input(id: string, data: string): void {
    const t = this.tab(id);
    t.typed = unsentAfter(t.typed, data);
  }

  exit(id: string): void {
    this.tabs.delete(id);
  }

  view(id: string): TabView | null {
    const t = this.tabs.get(id);
    if (!t) return null;
    return {
      state: t.state,
      stateAt: t.stateAt,
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
