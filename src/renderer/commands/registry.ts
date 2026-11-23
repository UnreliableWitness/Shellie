import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useStore } from '../store';
import { globalCommands } from './global';
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
export function contributed(): Command[] {
  return inSourceOrder(useSources.getState());
}

/** Every command there is right now: the store's own, then what components offer, by group. */
export function allCommands(): Command[] {
  return ordered([...globalCommands(useStore.getState()), ...contributed()]);
}

/** `allCommands`, following the store and the offers. Use it only where it is on screen: it follows every store change. */
export function useAllCommands(): Command[] {
  const store = useStore();
  const offered = useSources();
  return useMemo(
    () => ordered([...globalCommands(store), ...inSourceOrder(offered)]),
    [store, offered],
  );
}
