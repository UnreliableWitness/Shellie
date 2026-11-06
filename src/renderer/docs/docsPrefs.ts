import { local } from '../localStorage';
import { readFlag, writeFlag } from '../uiPrefs';

export type DocView = 'rendered' | 'source';
export type DocState = { path: string | null; view: DocView; scroll: number };
const DEFAULT: DocState = { path: null, view: 'rendered', scroll: 0 };

export function readDocState(taskId: string, storage = local()): DocState {
  try {
    const v = JSON.parse(
      storage?.getItem(`shellie.docs.${taskId}`) ?? 'null',
    ) as Partial<DocState> | null;
    if (!v || typeof v !== 'object') return { ...DEFAULT };
    return {
      path: typeof v.path === 'string' ? v.path : null,
      view: v.view === 'source' ? 'source' : 'rendered',
      scroll: typeof v.scroll === 'number' && v.scroll >= 0 ? v.scroll : 0,
    };
  } catch {
    return { ...DEFAULT };
  }
}
export function writeDocState(
  taskId: string,
  state: DocState,
  storage = local(),
): void {
  try {
    storage?.setItem(`shellie.docs.${taskId}`, JSON.stringify(state));
  } catch {
    /* best effort */
  }
}
export const readListCollapsed = (storage = local()): boolean =>
  readFlag('shellie.docs.listCollapsed', storage);
export const writeListCollapsed = (v: boolean, storage = local()): void =>
  writeFlag('shellie.docs.listCollapsed', v, storage);
export const readSendTarget = (
  taskId: string,
  storage = local(),
): string | null => {
  try {
    return storage?.getItem(`shellie.docs.sendTo.${taskId}`) ?? null;
  } catch {
    return null;
  }
};
export const writeSendTarget = (
  taskId: string,
  id: string,
  storage = local(),
): void => {
  try {
    storage?.setItem(`shellie.docs.sendTo.${taskId}`, id);
  } catch {
    /* best effort */
  }
};

/** The file list shows the task's session docs (default) or every doc in the worktree. */
export type DocsMode = 'session' | 'all';
export const readDocsMode = (taskId: string, storage = local()): DocsMode => {
  try {
    return storage?.getItem(`shellie.docs.mode.${taskId}`) === 'all'
      ? 'all'
      : 'session';
  } catch {
    return 'session';
  }
};
export const writeDocsMode = (
  taskId: string,
  mode: DocsMode,
  storage = local(),
): void => {
  try {
    storage?.setItem(`shellie.docs.mode.${taskId}`, mode);
  } catch {
    /* best effort */
  }
};
