import type { Interval } from '../../shared/time';

type Deps = {
  now: () => number;
  /** The task of an OpenCode terminal, null for any other terminal. */
  watch: (terminalId: string) => { taskId: string } | null;
  onInterval: (taskId: string, iv: Interval) => void;
  gapMs?: number;
};

type State = { taskId: string; armed: boolean; open: Interval | null };

/** Estimates agent time for terminals without telemetry: output after Enter counts, a gap of more than `gapMs` ends it and needs a new Enter. */
export class TerminalAgentTimer {
  /** Null for a terminal `watch` did not claim, so it is not asked again for every chunk of output. */
  private readonly states = new Map<string, State | null>();
  private readonly gapMs: number;

  constructor(private readonly d: Deps) {
    this.gapMs = d.gapMs ?? 30_000;
  }

  input(terminalId: string, data: string): void {
    if (!data.includes('\r')) return;
    const st = this.state(terminalId);
    if (st) st.armed = true;
  }

  output(terminalId: string): void {
    const st = this.state(terminalId);
    if (!st) return;
    const now = this.d.now();
    if (st.open && now - st.open[1] > this.gapMs) this.end(st);
    if (!st.armed) return;
    if (st.open) st.open[1] = now;
    else st.open = [now, now];
  }

  tick(): void {
    const now = this.d.now();
    for (const st of this.states.values())
      if (st?.open && now - st.open[1] > this.gapMs) this.end(st);
  }

  close(terminalId: string): void {
    const st = this.states.get(terminalId);
    if (!st) return;
    this.end(st);
    this.states.delete(terminalId);
  }

  private end(st: State): void {
    const iv = st.open;
    st.open = null;
    st.armed = false;
    if (iv) this.d.onInterval(st.taskId, iv);
  }

  private state(terminalId: string): State | null {
    const known = this.states.get(terminalId);
    if (known !== undefined) return known;
    const w = this.d.watch(terminalId);
    const st: State | null = w
      ? { taskId: w.taskId, armed: false, open: null }
      : null;
    this.states.set(terminalId, st);
    return st;
  }
}
