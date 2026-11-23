import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import { focusCommand, globalCommands } from './global';
import { type Command, GROUP_ORDER } from './types';

/**
 * What mounted components offer, by source. `order` is every source that ever offered, in the order of its first
 * offer: a source that offers a new list keeps its place, so the palette's rows do not jump while it is open.
 */
const useSources = create<{
  sources: Record<string, Command[]>;
  order: string[];
}>(() => ({ sources: {}, order: [] }));

/** The task bar's own commands (its tabs and terminals) lead "This task", whichever component's effect ran first. */
const FIRST_SOURCE = 'task';

/** Every offered command, source by source. */
function inSourceOrder(s: {
  sources: Record<string, Command[]>;
  order: string[];
}): Command[] {
  return [
    FIRST_SOURCE,
    ...s.order.filter((source) => source !== FIRST_SOURCE),
  ].flatMap((source) => s.sources[source] ?? []);
}

/**
 * Offers a component's commands for as long as it is mounted: the palette and the shortcuts see them, and they go
 * when the component does. Pass a memoised list (a new one replaces the last); an empty list offers nothing.
 * The component already holds what its commands need, so nothing is fetched for the palette's sake.
 */
export function useContributeCommands(
  source: string,
  commands: Command[],
): void {
  useEffect(() => {
    if (commands.length === 0) return;
    useSources.setState((s) => ({
      sources: { ...s.sources, [source]: commands },
      order: s.order.includes(source) ? s.order : [...s.order, source],
    }));
    return () =>
      useSources.setState((s) => {
        // A later offer under the same source (a remount) is not this one's to remove.
        if (s.sources[source] !== commands) return s;
        const { [source]: _gone, ...rest } = s.sources;
        return { sources: rest };
      });
  }, [source, commands]);
}

/** Group order, and within a group the order given, with the commands marked `last` after the rest. */
function ordered(commands: Command[]): Command[] {
  return GROUP_ORDER.flatMap((g) => {
    const group = commands.filter((c) => c.group === g);
    return [...group.filter((c) => !c.last), ...group.filter((c) => c.last)];
  });
}

/** Every command a mounted component offers. */
function contributed(): Command[] {
  return inSourceOrder(useSources.getState());
}

/**
 * The offered commands whose id starts with `prefix`; none for null. It re-renders its caller only when that set
 * changes, so a component on the terminal's render path can list a few commands without following every offer.
 */
export function useContributedWith(prefix: string | null): Command[] {
  return useSources(
    useShallow((s) =>
      prefix === null
        ? NONE
        : inSourceOrder(s).filter((c) => c.id.startsWith(prefix)),
    ),
  );
}
const NONE: Command[] = [];

/** What mounted components offer, following the offers only (not the store): for a menu built from them. */
export function useContributed(): Command[] {
  const offered = useSources();
  return useMemo(() => inSourceOrder(offered), [offered]);
}

/**
 * The commands a key press can run: what components offer, then Focus mode. The shortcut handler asks on every key
 * with the mod key down (every Ctrl+C in a shell), so this builds nothing: no task list, no places.
 */
export function shortcutCommands(): Command[] {
  return [...contributed(), focusCommand()].filter((c) => c.shortcut);
}

/** Every command there is right now: the store's own, then what components offer, by group. */
export function allCommands(): Command[] {
  return ordered([...globalCommands(useStore.getState()), ...contributed()]);
}

/**
 * `allCommands`, following the offers and the parts of the store its commands are built from (the tasks, the
 * projects, what is on screen), not every store change: an agent's attention or a reading update leaves it alone.
 */
export function useAllCommands(): Command[] {
  const built = useStore(
    useShallow((s) => [
      s.tasks,
      s.repos,
      s.connections,
      s.connectionId,
      s.selectedTaskId,
      s.screen,
      s.navCollapsed,
    ]),
  );
  const offered = useSources();
  return useMemo(
    () =>
      ordered([
        ...globalCommands(useStore.getState()),
        ...inSourceOrder(offered),
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `built` is what globalCommands reads from the store
    [built, offered],
  );
}
