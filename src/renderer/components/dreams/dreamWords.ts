import type {
  DreamJournalEntry,
  DreamProposal,
  DreamProposalKind,
  DreamView,
  DreamWait,
} from '../../../shared/dreams';
import { taskSlug } from '../../../shared/naming';
import { plural } from '../../format';
import { spacedNumber } from './folders';

type ViewRepo = DreamView['repos'][number];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const DAY_MS = 86_400_000;

const startOfDay = (d: Date): number =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The day in words: today, yesterday, a weekday within the last 6 days, else "12 Nov". */
export function dayWords(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(d)) / DAY_MS);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days > 1 && days <= 6) return WEEKDAYS[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** A moment in words: "today 03:12", "yesterday 22:40", "Wed 13:05", "12 Nov". */
export function whenWords(iso: string, now: number): string {
  const day = dayWords(iso, now);
  if (/^\d/.test(day)) return day;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

/** A date as "14 Nov": a `YYYY-MM-DD` day or an ISO moment (local); anything else as it is. */
export function shortDate(s: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = day
    ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    : new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export const minutesSince = (startedAt: number, now: number): number =>
  Math.max(0, Math.floor((now - startedAt) / 60_000));

/** One decimal, no trailing ".0": 1200000 as "1.2", 5000000 as "5". */
const millions = (n: number): string => String(Math.round(n / 1e5) / 10);

/** Why a dream is not running, in words (`dream:now` and the scheduler share them). */
export function waitLine(wait: DreamWait, model: string | null): string {
  switch (wait) {
    case 'off':
      return 'Dreams are off';
    case 'model-missing':
      return `${model ?? 'The model'} is not available in OpenCode`;
    case 'active':
      return 'Waiting until you are away';
    case 'battery':
      return 'Waiting for mains power';
    case 'agents-busy':
      return 'Waiting: an agent is working';
    case 'running':
      return 'A dream is already running';
    case 'running-elsewhere':
      return 'Another project is dreaming';
    case 'limit':
      return "Today's limit reached";
    case 'nothing-ready':
      return 'Nothing new to dream about';
  }
}

/** What is happening now: the running dream, or the reason none starts. */
export function nowLine(view: DreamView, now: number = Date.now()): string {
  if (view.running) {
    const name =
      view.repos.find((r) => r.id === view.running?.repoId)?.name ?? 'a repo';
    return `Dreaming about ${name}, ${minutesSince(view.running.startedAt, now)} min`;
  }
  if (view.waiting === null) return 'Waiting for the first check';
  return waitLine(view.waiting, view.settings.model);
}

/** Today's usage against the limit, with the bar's percentage (null: no limit, or a spend that cannot be measured). */
export function usageText(view: DreamView): {
  text: string;
  percent: number | null;
} {
  const { tokens, eur } = view.usage;
  const limit = view.settings.limit;
  const pct = (used: number, of: number) =>
    Math.min(100, Math.round((used / of) * 100));
  if (limit?.kind === 'eur') {
    const max = `€ ${limit.perDay.toFixed(2)}`;
    return eur === null
      ? { text: `Spend unknown, limit ${max}`, percent: null }
      : {
          text: `€ ${eur.toFixed(2)} of ${max}`,
          percent: pct(eur, limit.perDay),
        };
  }
  const big = (n: number) => n >= 100_000;
  if (limit?.kind === 'tokens') {
    const text =
      big(tokens) && big(limit.perDay)
        ? `${millions(tokens)} of ${millions(limit.perDay)} million tokens`
        : `${spacedNumber(tokens)} of ${spacedNumber(limit.perDay)} tokens`;
    return { text, percent: pct(tokens, limit.perDay) };
  }
  const used = big(tokens)
    ? `${millions(tokens)} million tokens`
    : `${spacedNumber(tokens)} tokens`;
  return { text: `${used} · no limit`, percent: null };
}

/** What the journal says about a past dream, up to its end. */
export function journalLine(e: DreamJournalEntry): string {
  const n = plural(e.proposals, 'proposal');
  switch (e.outcome) {
    case 'proposed': {
      if (e.closed?.as === 'discarded') return `${n} · discarded`;
      if (e.closed) {
        const task = e.closed.taskName
          ? `opened as task “${e.closed.taskName}”`
          : 'opened as a task';
        const dropped =
          e.closed.dropped > 0 ? ` · ${e.closed.dropped} dropped` : '';
        return `${n} · ${e.closed.kept} kept, ${task}${dropped}`;
      }
      const checked =
        e.removedByCheck > 0
          ? ` · ${e.removedByCheck} more removed by its own check`
          : '';
      return `${n}, waiting for you${checked}`;
    }
    case 'nothing':
      return 'Nothing to propose';
    case 'interrupted':
      return e.reason === 'suspend'
        ? 'Stopped: the machine went to sleep'
        : 'Stopped: you pressed Stop';
    case 'limit':
      return "Stopped at today's limit";
    case 'wrong-model':
      return 'Thrown away: answered by another model';
    case 'failed':
      return `Failed: ${e.reason ?? 'unknown reason'}`;
  }
}

/** One repo's state in words. `now` is for the day words. */
export function repoStateLine(
  r: ViewRepo,
  view: DreamView,
  now: number = Date.now(),
): string {
  if (!view.settings.enabled || !view.settings.repos[r.id]?.on)
    return 'Its sessions are never read';
  const { result, failures, lastFailure, lastDreamAt } = r.state;
  const sessions = (n: number) => plural(n, 'new session');
  if (result)
    return r.newSessions > 0
      ? `${sessions(r.newSessions)} ${r.newSessions === 1 ? 'waits' : 'wait'} until you have reviewed ${dayWords(result.at, now)}'s dream`
      : `Its dream from ${whenWords(result.at, now)} waits for your review`;
  if (failures > 0 && lastFailure) return `Keeps failing: ${lastFailure}`;
  if (r.newSessions > 0) return sessions(r.newSessions);
  if (lastDreamAt) return `Nothing new since ${whenWords(lastDreamAt, now)}`;
  return 'Nothing new yet';
}

/** The status line at the foot of the navigation. */
export function navLine(
  view: DreamView,
  now: number = Date.now(),
): { line: string; model: string; tone: 'quiet' | 'active' | 'warn' } {
  const s = view.settings;
  if (!s.enabled) return { line: 'Dreams off', model: '', tone: 'quiet' };
  const model = s.model ?? '';
  if (view.running) {
    const name =
      view.repos.find((r) => r.id === view.running?.repoId)?.name ?? 'a repo';
    return {
      line: `Dreaming about ${name}`,
      model: `${model} · ${minutesSince(view.running.startedAt, now)} min`,
      tone: 'active',
    };
  }
  if (s.limit?.kind === 'none')
    return { line: 'Dreams on · no limit', model, tone: 'warn' };
  return { line: 'Dreams on', model, tone: 'quiet' };
}

/** The dream step shown in the running panel. */
export function stepLine(
  step: 'reading' | 'checking',
  sessions: number | null,
): string {
  if (step === 'checking') return 'Checking its own proposals';
  return sessions && sessions > 0
    ? `Reading ${sessions} session${sessions === 1 ? '' : 's'}`
    : 'Reading sessions';
}

/** The project's own repos: the ones that can be set up to dream (a repo without a project only shows what it left). */
export const ownRepos = (view: DreamView): ViewRepo[] =>
  view.repos.filter((r) => !r.orphan);

/** The repos with a result waiting for review, as the navigation counts them. */
export const openResults = (view: DreamView): ViewRepo[] =>
  view.repos.filter((r) => r.state.result !== null);

/** The repos with a result opened as a task whose task is not made yet. */
export const openedResults = (view: DreamView): ViewRepo[] =>
  view.repos.filter((r) => r.state.opened !== null);

/** What waits for the owner: open results and results opened as a task without their task. */
export const waitingCount = (view: DreamView): number =>
  openResults(view).length + openedResults(view).length;

export const KIND_LABEL: Record<DreamProposalKind, string> = {
  'new-rule': 'New rule',
  'changed-rule': 'Changed rule',
  'new-skill': 'New skill',
  'changed-skill': 'Changed skill',
  'new-agent': 'New agent',
  'changed-agent': 'Changed agent',
};

/** A proposal's short line in the list: its kind and in how many tasks it was seen, or Dropped. */
export function proposalLine(
  p: Pick<DreamProposal, 'kind' | 'dropped' | 'evidence'>,
): string {
  if (p.dropped) return 'Dropped';
  const tasks = new Set(p.evidence.map((e) => e.taskId)).size;
  return tasks > 0
    ? `${KIND_LABEL[p.kind]} · seen in ${plural(tasks, 'task')}`
    : KIND_LABEL[p.kind];
}

/** The line under the proposals when the dream's own check removed ideas; null when it removed none. */
export function checkLine(removedByCheck: number): string | null {
  if (removedByCheck <= 0) return null;
  if (removedByCheck === 1)
    return "One more idea did not survive the dream's own check. It is remembered in case it comes up again.";
  return `${removedByCheck} more ideas did not survive the dream's own check. They are remembered in case they come up again.`;
}

/**
 * The name of a task opened from a dream made at `at`: `Dream <date>`, or `Dream <date> 2`, `3`, … when a task of
 * the repo already has that name or folder. `tasks:create` refuses a clash the store does not know.
 */
export function dreamTaskName(
  at: string,
  repoId: string,
  tasks: { repoId: string | null; name: string; worktreePath: string }[],
): string {
  const mine = tasks.filter((t) => t.repoId === repoId);
  const names = new Set(mine.map((t) => t.name));
  const folders = new Set(
    mine.map((t) => t.worktreePath.split(/[\\/]/).pop() ?? ''),
  );
  const base = `Dream ${shortDate(at)}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!names.has(name) && !folders.has(taskSlug(null, name))) return name;
  }
}
