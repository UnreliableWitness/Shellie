import { z } from 'zod';
import { SourceTypeSchema, type SourceType } from '../../../../shared/brain';
import { local } from '../../../localStorage';

/** A file in the composer: `ownNote` null takes the shared note; a string (even empty) is its Own note field. */
export type DraftFile = {
  name: string;
  path: string;
  bytes: number;
  type: SourceType;
  ownNote: string | null;
};

/** What the Add view's composer holds for one brain until Add or Discard; `model` null is the brain's model. */
export type ComposerDraft = {
  title: string;
  text: string;
  textType: SourceType;
  note: string;
  files: DraftFile[];
  model: string | null;
};

export const EMPTY_DRAFT: ComposerDraft = {
  title: '',
  text: '',
  textType: 'note',
  note: '',
  files: [],
  model: null,
};

export const DRAFT_KEY = (brainId: string) => `shellie.brain.draft.${brainId}`;

const Stored = z.object({
  title: z.string(),
  text: z.string(),
  textType: SourceTypeSchema,
  note: z.string(),
  files: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      bytes: z.number(),
      type: SourceTypeSchema,
      ownNote: z.string().nullable(),
    }),
  ),
});

/** The draft kept in local storage for a reload or a crash; never the model (Capture with starts on the brain's). */
export function restoreDraft(brainId: string): ComposerDraft {
  try {
    const raw = local()?.getItem(DRAFT_KEY(brainId));
    if (!raw) return EMPTY_DRAFT;
    const r = Stored.safeParse(JSON.parse(raw));
    return r.success ? { ...r.data, model: null } : EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
}

const SAVE_MS = 300;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Writes the draft a moment after the last change; an empty draft removes the key. A convenience: failures are ignored. */
export function saveDraft(brainId: string, draft: ComposerDraft): void {
  clearTimeout(timers.get(brainId));
  timers.set(
    brainId,
    setTimeout(() => {
      timers.delete(brainId);
      try {
        const { model: _m, ...kept } = draft;
        const empty =
          !kept.text.trim() &&
          !kept.title.trim() &&
          !kept.note.trim() &&
          kept.files.length === 0;
        if (empty) local()?.removeItem(DRAFT_KEY(brainId));
        else local()?.setItem(DRAFT_KEY(brainId), JSON.stringify(kept));
      } catch {
        // The draft still lives in the store.
      }
    }, SAVE_MS),
  );
}
