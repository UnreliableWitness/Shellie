import { useCallback, useEffect, useState } from 'react';

/**
 * Where the reader is: the reading list, a piece, or a cited page over a piece. It lives in the browser's history
 * (`history.state`), so the phone's back gesture steps back; the address itself never changes, so no title or path
 * ever shows in it.
 */
export type Route = {
  /** The path in the brain of the long read or letter that is open; null on the reading list. */
  piece: string | null;
  /** The heading a link into the piece pointed at. */
  anchor?: string;
  /** The cited page shown over the piece. */
  ref: { path: string; anchor?: string } | null;
  /** History entries above the reading list. */
  depth: number;
  /** History entries above the piece: the pages opened one from another in the sheet. */
  sheets: number;
};

const HOME: Route = { piece: null, ref: null, depth: 0, sheets: 0 };

function routeIn(state: unknown): Route {
  const s = state as { reader?: Partial<Route> } | null;
  const r = s?.reader;
  if (!r || typeof r.depth !== 'number' || typeof r.sheets !== 'number')
    return HOME;
  return {
    piece: typeof r.piece === 'string' ? r.piece : null,
    anchor: typeof r.anchor === 'string' ? r.anchor : undefined,
    ref: r.ref && typeof r.ref.path === 'string' ? r.ref : null,
    depth: r.depth,
    sheets: r.sheets,
  };
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => routeIn(history.state));
  useEffect(() => {
    const onPop = (e: PopStateEvent) => setRoute(routeIn(e.state));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const push = useCallback((next: Route) => {
    history.pushState({ reader: next }, '');
    setRoute(next);
  }, []);
  const back = useCallback((steps: number) => {
    if (steps > 0) history.go(-steps);
  }, []);

  return {
    route,
    /** Opens a long read or a letter. */
    openPiece: useCallback(
      (path: string, anchor?: string) =>
        push({
          piece: path,
          anchor,
          ref: null,
          depth: routeIn(history.state).depth + 1,
          sheets: 0,
        }),
      [push],
    ),
    /** Shows a cited page over the piece, or in place of the page the sheet shows now. */
    openRef: useCallback(
      (path: string, anchor?: string) => {
        const now = routeIn(history.state);
        push({
          ...now,
          ref: { path, anchor },
          depth: now.depth + 1,
          sheets: now.sheets + 1,
        });
      },
      [push],
    ),
    /** Back to the piece under the sheet, however many pages were opened in it. */
    closeRef: useCallback(() => back(routeIn(history.state).sheets), [back]),
    /** Back to the reading list. */
    home: useCallback(() => back(routeIn(history.state).depth), [back]),
    /** Forgets where the reader was (the phone is forgotten). */
    reset: useCallback(() => {
      history.replaceState(null, '');
      setRoute(HOME);
    }, []),
  };
}
