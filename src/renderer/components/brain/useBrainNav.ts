import { useCallback, useState } from 'react';
import { trackBrain } from './brainActions';

export type NavEntry = { path: string; anchor?: string };

/**
 * Where the reader is inside a brain view: null on the lists, else a page or source, with back and forward over
 * the pages opened. Lives with the view: switching pivots or tabs forgets it.
 */
export function useBrainNav() {
  const [stack, setStack] = useState<NavEntry[]>([]);
  const [at, setAt] = useState(-1);
  const current: NavEntry | null = at >= 0 ? stack[at] : null;
  // Bumped by every open, so a reader opening the page already shown is told to scroll to it again.
  const [opened, setOpened] = useState(0);

  const open = useCallback(
    (path: string, anchor?: string) => {
      trackBrain('open-page');
      setOpened((n) => n + 1);
      // The page already shown is not a new place: Back would otherwise appear to do nothing once.
      const here = at >= 0 ? stack[at] : null;
      if (here && here.path === path && here.anchor === anchor) return;
      setStack((s) => [...s.slice(0, at + 1), { path, anchor }]);
      setAt(at + 1);
    },
    [at, stack],
  );
  /** Back to the previous page, or to the lists from the first one. */
  const back = useCallback(() => {
    if (at < 0) return;
    trackBrain('back');
    setAt(at - 1);
  }, [at]);
  const forward = useCallback(() => {
    if (at >= stack.length - 1) return;
    trackBrain('back');
    setAt(at + 1);
  }, [at, stack.length]);
  const home = useCallback(() => setAt(-1), []);

  return {
    current,
    /** Counts the opens, the identical ones too. */
    opened,
    open,
    back,
    forward,
    home,
    canBack: at >= 0,
    canForward: at < stack.length - 1,
  };
}
