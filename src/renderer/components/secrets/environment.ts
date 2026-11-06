import type { Environment } from '../../../shared/secrets';

/** The text colour of an environment's name: amber for UAT, red for Production, plain otherwise. */
export const envTextClass = (env: Environment): string | undefined =>
  env === 'production' ? 'text-red' : env === 'uat' ? 'text-warn' : undefined;

/** How the confirm and the band name tabs: run tabs by their label, then "your shell" (once). */
export function tabNames(tabs: { kind: string; label: string }[]): string[] {
  const runs = [
    ...new Set(tabs.filter((t) => t.kind !== 'shell').map((t) => t.label)),
  ];
  return tabs.some((t) => t.kind === 'shell') ? [...runs, 'your shell'] : runs;
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** "51077" for a work item, else the task name. */
export const taskShortName = (t: {
  workItem: { id: string } | null;
  name: string;
}): string => t.workItem?.id || t.name;
