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

  const open = useCallback(
    (path: string, anchor?: string) => {
      trackBrain('open-page');
      setStack((s) => [...s.slice(0, at + 1), { path, anchor }]);
      setAt(at + 1);
    },
    [at],
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
    open,
    back,
    forward,
    home,
    canBack: at >= 0,
    canForward: at < stack.length - 1,
  };
}
