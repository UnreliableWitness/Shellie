import type { AttentionEntry } from '../../shared/attention';

/** What a waiting terminal wants, for the dot's label and tooltip. */
export function attentionLabel(e: AttentionEntry): string {
  const head =
    e.reason === 'done'
      ? 'Finished'
      : e.kind === 'permission'
        ? 'Needs permission'
        : e.kind === 'question'
          ? 'Has a question'
          : 'Waiting for you';
  return e.message ? `${head}: ${e.message}` : head;
}

/** Amber when an agent is blocked on the developer, accent when it finished its turn. */
export function AttentionDot({ entry }: { entry: AttentionEntry }) {
  const label = attentionLabel(entry);
  return (
    <span
      className={`attention-dot attention-${entry.reason}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
