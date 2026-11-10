import { useMemo } from 'react';
import { useStore } from '../../../store';
import { EMPTY_DRAFT, restoreDraft, type ComposerDraft } from './draftStorage';

export {
  EMPTY_DRAFT,
  type ComposerDraft,
  type DraftFile,
} from './draftStorage';

/** Nothing worth keeping: no text, title, note or file (the model alone is not a draft). */
export const draftIsEmpty = (d: ComposerDraft): boolean =>
  !d.text.trim() && !d.title.trim() && !d.note.trim() && d.files.length === 0;

/**
 * The composer's draft for a brain: in the store (it survives switching views and brains) and in local storage
 * (it survives a reload). A brain with nothing in the store starts from what local storage kept.
 */
export function useComposerDraft(brainId: string) {
  const stored = useStore((s) => s.brainDrafts[brainId]);
  const setBrainDraft = useStore((s) => s.setBrainDraft);
  const draft = useMemo(
    () => stored ?? restoreDraft(brainId),
    [stored, brainId],
  );
  const update = (
    patch: Partial<ComposerDraft> | ((d: ComposerDraft) => ComposerDraft),
  ) =>
    setBrainDraft(brainId, (d) =>
      typeof patch === 'function' ? patch(d) : { ...d, ...patch },
    );
  const clear = () => setBrainDraft(brainId, () => EMPTY_DRAFT);
  return { draft, update, clear, isEmpty: draftIsEmpty(draft) };
}
