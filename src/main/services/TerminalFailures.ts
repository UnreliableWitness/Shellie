import {
  diagnoseExit,
  EARLY_EXIT_MS,
  spawnFailure,
  type TerminalFailure,
  type TerminalKind,
} from '../../shared/terminalFailure';
import { errorMessage } from '../../shared/errors';
import type { Telemetry } from '../telemetry/AppInsightsClient';

/**
 * Explains why an agent tab stopped (#109) and logs it. The diagnosis is kept per terminal so a view that mounts
 * after the exit still shows it; telemetry gets the kind, the reason and the exit code, never the output.
 */
export class TerminalFailures {
  private readonly failures = new Map<string, TerminalFailure>();

  constructor(
    private readonly deps: {
      buffer: (id: string) => string;
      runMs: (id: string) => number;
      kindOf: (id: string) => TerminalKind | undefined;
      telemetry: Pick<Telemetry, 'event' | 'exception'>;
    },
  ) {}

  /** Called on every exit; returns the failure to show, or null. */
  exit(id: string, exitCode: number): TerminalFailure | null {
    this.failures.delete(id);
    const kind = this.deps.kindOf(id);
    if (!kind) return null;
    const runMs = Math.round(this.deps.runMs(id));
    let output = '';
    try {
      output = this.deps.buffer(id);
    } catch {
      // Forgotten already (killed): nothing to read.
    }
    const failure = diagnoseExit({ kind, exitCode, output, runMs });
    if (failure) {
      this.failures.set(id, failure);
      this.deps.telemetry.event(
        'terminal.failed',
        { kind, reason: failure.reason, exitCode: String(exitCode) },
        { runMs },
      );
    } else if (exitCode !== 0 && runMs < EARLY_EXIT_MS)
      this.deps.telemetry.event(
        'terminal.exitedEarly',
        { kind, exitCode: String(exitCode) },
        { runMs },
      );
    return failure;
  }

  /** The program could not be started at all (the pty spawn threw). */
  spawnFailed(id: string, kind: TerminalKind, error: unknown): TerminalFailure {
    const failure = spawnFailure(kind, errorMessage(error));
    this.failures.set(id, failure);
    this.deps.telemetry.exception(error, { source: 'terminal', kind });
    this.deps.telemetry.event('terminal.failed', {
      kind,
      reason: failure.reason,
      exitCode: 'none',
    });
    return failure;
  }

  get(id: string): TerminalFailure | null {
    return this.failures.get(id) ?? null;
  }

  clear(id: string): void {
    this.failures.delete(id);
  }
}
