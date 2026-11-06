import { local } from '../localStorage';

export type ReviewPrefs = {
  sideBySide: boolean;
  ignoreWhitespace: boolean;
  hideUnchanged: boolean;
  /** The Files panel as a folder tree or a flat list. */
  fileView: 'tree' | 'list';
};
const KEY = 'shellie.review.prefs';
const DEFAULT: ReviewPrefs = {
  sideBySide: true,
  ignoreWhitespace: false,
  hideUnchanged: true,
  fileView: 'tree',
};

export function readReviewPrefs(
  storage: Storage | undefined = local(),
): ReviewPrefs {
  try {
    const v = JSON.parse(
      storage?.getItem(KEY) ?? 'null',
    ) as Partial<ReviewPrefs> | null;
    return {
      sideBySide:
        typeof v?.sideBySide === 'boolean' ? v.sideBySide : DEFAULT.sideBySide,
      ignoreWhitespace:
        typeof v?.ignoreWhitespace === 'boolean'
          ? v.ignoreWhitespace
          : DEFAULT.ignoreWhitespace,
      hideUnchanged:
        typeof v?.hideUnchanged === 'boolean'
          ? v.hideUnchanged
          : DEFAULT.hideUnchanged,
      fileView:
        v?.fileView === 'list' || v?.fileView === 'tree'
          ? v.fileView
          : DEFAULT.fileView,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function writeReviewPrefs(
  p: ReviewPrefs,
  storage: Storage | undefined = local(),
): void {
  try {
    storage?.setItem(KEY, JSON.stringify(p));
  } catch {
    /* best effort */
  }
}
