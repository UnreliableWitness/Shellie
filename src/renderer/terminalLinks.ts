import type {
  ILink,
  ILinkHandler,
  ILinkProvider,
  Terminal,
} from '@xterm/xterm';
import { api } from './api';
import { findLinks } from './docs/linkify';
import { useStore } from './store';
import { track } from './telemetry';
import { docsTarget } from '../shared/workspaces';
import { errorMessage } from '../shared/errors';
import type { Channels } from '../shared/ipc';

export type BufferLike = {
  getLine(
    y: number,
  ):
    | { isWrapped: boolean; translateToString(trimRight?: boolean): string }
    | undefined;
};
export type LinkTarget =
  | {
      type: 'md' | 'html' | 'file';
      path: string;
      line?: number;
      col?: number;
      workspaceId?: string;
    }
  | { type: 'url'; url: string };
type Resolve = (
  taskId: string,
  path: string,
) => Promise<Channels['docs:resolve']['result']>;

/** findLinks is quadratic on long lines: only the first 2,000 characters are scanned. */
const MAX_SCAN = 2000;

/** The whole logical line a row belongs to (xterm splits long lines into wrapped rows). */
export function logicalLine(
  buf: BufferLike,
  y: number,
): { text: string; firstRow: number } {
  let first = y;
  while (first > 0 && buf.getLine(first)?.isWrapped) first--;
  let text = '';
  let row = first;
  for (;;) {
    const line = buf.getLine(row);
    if (!line) break;
    const continues = Boolean(buf.getLine(row + 1)?.isWrapped);
    text += line.translateToString(!continues);
    if (!continues) break;
    row++;
  }
  return { text, firstRow: first };
}

/** One cell per character: wide characters before a link shift it; acceptable for paths and URLs, which are ASCII in practice. */
export const cellAt = (cols: number, firstRow: number, index: number) => ({
  x: (index % cols) + 1,
  y: firstRow + Math.floor(index / cols) + 1,
});

export function openLink(taskId: string, target: LinkTarget): void {
  track('terminal.linkOpened', { type: target.type });
  if (target.type === 'url')
    void api()
      .invoke('links:open', target.url)
      .catch(() => undefined);
  else if (target.type === 'md')
    useStore
      .getState()
      .openDoc(taskId, target.path, target.line, target.workspaceId);
  else if (target.type === 'html')
    useStore.getState().openView(taskId, target.path, target.workspaceId);
  else
    void api()
      .invoke(
        'docs:openInEditor',
        docsTarget(taskId, target.workspaceId),
        target.path,
        ...(target.line
          ? [target.line, ...(target.col ? [target.col] : [])]
          : []),
      )
      .catch((e: unknown) =>
        useStore.getState().notify('error', errorMessage(e)),
      );
}

/**
 * Links a program prints with OSC 8 (Claude Code's PR links). xterm's default asks
 * with confirm() and then opens a blank window, which main denies (#311); main's
 * links:open already allows only http(s), so no prompt is needed.
 */
export const oscLinkHandler = (
  taskId: string,
): ILinkHandler & { allowNonHttpProtocols: false } => ({
  activate: (_e, uri) => openLink(taskId, { type: 'url', url: uri }),
  allowNonHttpProtocols: false,
});

const LABELS = {
  md: 'Open in Docs',
  html: 'Open in a tab',
  file: 'Open in VS Code',
  url: 'Open in browser',
} as const;

const tooltip = (label: string) => ({
  hover: (e: MouseEvent) => {
    (e.target as HTMLElement).title = label;
  },
  leave: (e: MouseEvent) => {
    (e.target as HTMLElement).title = '';
  },
});

export function createLinkProvider(
  term: Pick<Terminal, 'cols'> & { buffer: { active: BufferLike } },
  taskId: string,
  deps: {
    resolve?: Resolve;
    open?: (t: LinkTarget) => void;
    /** The workspace the terminal runs in, tried first; absent means the task's active home. */
    workspaceId?: string;
  } = {},
): ILinkProvider {
  const resolve: Resolve =
    deps.resolve ??
    (async (t, p) => {
      const invoke = (target: string) =>
        api()
          .invoke('docs:resolve', target, p)
          .catch(() => null);
      // The terminal's own workspace first, then the task's others (main tries active home, then the rest).
      const own = deps.workspaceId
        ? await invoke(docsTarget(t, deps.workspaceId))
        : null;
      return own ?? invoke(t);
    });
  const open = deps.open ?? ((t: LinkTarget) => openLink(taskId, t));
  // Resolutions are cached per path (text-relative); null is never kept, so a
  // file created after its path was printed becomes a link on the next hover.
  const resolved = new Map<string, Promise<Awaited<ReturnType<Resolve>>>>();
  const resolveCached = (path: string) => {
    let p = resolved.get(path);
    if (!p) {
      p = resolve(taskId, path);
      if (resolved.size > 500) resolved.clear();
      resolved.set(path, p);
      void p.then((r) => {
        if (!r && resolved.get(path) === p) resolved.delete(path);
      });
    }
    return p;
  };
  return {
    provideLinks(lineNumber, callback) {
      const { text: full, firstRow } = logicalLine(
        term.buffer.active,
        lineNumber - 1,
      );
      const text = full.slice(0, MAX_SCAN);
      void Promise.all(
        findLinks(text).map(async (l): Promise<ILink | null> => {
          const range = {
            start: cellAt(term.cols, firstRow, l.start),
            end: cellAt(term.cols, firstRow, l.end - 1),
          };
          if (range.start.y > lineNumber || range.end.y < lineNumber)
            return null;
          if (l.kind === 'url')
            return {
              range,
              text: l.text,
              activate: () => open({ type: 'url', url: l.url }),
              ...tooltip(LABELS.url),
            };
          const r = await resolveCached(l.path).catch(() => null);
          if (!r) return null;
          return {
            range,
            text: l.text,
            activate: () =>
              open({
                type: r.kind,
                path: r.path,
                line: l.line,
                col: l.col,
                ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
              }),
            ...tooltip(LABELS[r.kind]),
          };
        }),
      ).then((ls) => callback(ls.filter((x): x is ILink => x !== null)));
    },
  };
}
