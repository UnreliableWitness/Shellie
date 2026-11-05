export { formatDuration } from '../shared/time';

/** An amount in euros with two decimals, such as "€1.50". */
export const eur = (n: number): string =>
  `${String.fromCharCode(0x20ac)}${(Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2)}`;

/** A euro amount short enough for a chart label: cents under €1,000, whole euros up to €100k, then "€123k". */
export const shortEur = (n: number): string => {
  const e = String.fromCharCode(0x20ac);
  const a = Math.abs(n);
  if (a < 999.995) return `${n < 0 ? '-' : ''}${e}${a.toFixed(2)}`;
  if (a < 99_999.5)
    return `${n < 0 ? '-' : ''}${e}${Math.round(a).toLocaleString('en-US')}`;
  return `${n < 0 ? '-' : ''}${e}${Math.round(a / 1000).toLocaleString('en-US')}k`;
};

export const compact = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);

export function ago(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 1440) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

/** A local date and time such as "15 Oct 2026, 12:01"; the UI never shows ISO strings. */
export const dateTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
};

/** A sprint's dates such as "15 Oct – 28 Oct". ADO stores them as UTC midnights, so they are read in UTC. Null when either is unset. */
export const sprintDates = (
  start: string | null,
  finish: string | null,
): string | null => {
  if (!start || !finish) return null;
  const day = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? null
      : d.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        });
  };
  const a = day(start);
  const b = day(finish);
  return a && b ? `${a} ${String.fromCharCode(0x2013)} ${b}` : null;
};

/** How long a task ran, such as "45 min", "3 h 5 min" or "2 d 3 h". */
export const duration = (fromIso: string, toIso: string): string | null => {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (Number.isNaN(ms) || ms < 0) return null;
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'under 1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
};

/** "1 file", "2 files"; pass `many` for an irregular plural. */
export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** A task in a list: "#4312 Checkout address form", or the name of a task without a work item. */
export const taskLabel = (t: {
  workItem: { id: string; title: string } | null;
  name: string;
}): string => (t.workItem ? `#${t.workItem.id} ${t.workItem.title}` : t.name);
