import { useState } from 'react';
import type {
  AddSourceResult,
  BrainView,
  SourceType,
} from '../../../../shared/brain';
import { api, tryInvoke } from '../../../api';
import { useStore } from '../../../store';
import { trackBrain, trackBrainAdd } from '../brainActions';
import { addedOf, guessType, type AddedSource } from '../useBrainDrop';
import { useComposerDraft, type DraftFile } from './draft';
import { isEditorText, titleFor } from './text';

/** What the last add brought in: the text's title (null without text), how many files, and per source its lines. */
export type ComposerAdded = {
  title: string | null;
  files: number;
  sources: AddedSource[];
};

/** Drops trailing undefined arguments, so an add without a note or model sends what it did before. */
const args = <T extends unknown[]>(...a: T): T => {
  const out = [...a];
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out as T;
};

const nameOnly = (name: string) => name.replace(/\.[^.]+$/, '');

/** The model kind telemetry may see: a Claude Code model's name, or just `opencode`. */
const modelKind = (brain: BrainView, model: string | null) =>
  brain.options.agent === 'opencode'
    ? 'opencode'
    : ((model ?? brain.options.model) as 'haiku' | 'sonnet' | 'opus');

/**
 * The composer's state for a brain: its draft (text, files, note, model), what could not be added, and what the
 * last add brought in. `addFiles` takes drops and the file picker; `add` sends everything in one press.
 */
export function useComposer(brain: BrainView) {
  const brainId = brain.id;
  const notify = useStore((s) => s.notify);
  const { draft, update, clear, isEmpty } = useComposerDraft(brainId);
  const [problems, setProblems] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<ComposerAdded | null>(null);

  /** A Markdown or text file fills an empty editor (the first one only); every other file becomes a chip. */
  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    trackBrain('drop');
    const lost: string[] = [];
    let editorFree = draft.text.trim() === '';
    const chips: DraftFile[] = [];
    for (const f of files) {
      if (editorFree && isEditorText(f.name)) {
        editorFree = false;
        const body = await f.text().catch(() => null);
        if (body !== null) {
          update((d) => ({
            ...d,
            text: body,
            title: d.title.trim() ? d.title : nameOnly(f.name),
            textType: 'doc',
          }));
          continue;
        }
      }
      const path = api().pathForFile(f);
      if (!path) {
        lost.push(`${f.name || 'A file'}: not a file on disk`);
        continue;
      }
      chips.push({
        name: f.name,
        path,
        bytes: f.size,
        type: guessType(f.name),
        ownNote: null,
      });
    }
    if (chips.length)
      update((d) => {
        const have = new Set(d.files.map((x) => x.path));
        const next = [...d.files];
        for (const c of chips)
          if (!have.has(c.path)) {
            have.add(c.path);
            next.push(c);
          }
        return { ...d, files: next };
      });
    setProblems(lost);
  };

  const setFile = (path: string, patch: Partial<DraftFile>) =>
    update((d) => ({
      ...d,
      files: d.files.map((f) => (f.path === path ? { ...f, ...patch } : f)),
    }));
  const removeFile = (path: string) =>
    update((d) => ({ ...d, files: d.files.filter((f) => f.path !== path) }));

  /** Sends the text and the files; what went in leaves the draft, what failed stays with its problem. True when all went in. */
  const add = async (): Promise<boolean> => {
    const d = draft;
    const text = d.text.trim() ? d.text : null;
    if ((!text && d.files.length === 0) || adding) return false;
    const note = d.note.trim() || undefined;
    const model = d.model ?? undefined;
    trackBrainAdd({
      text: !!text,
      files: d.files.length,
      note: !!note,
      ownNotes: d.files.filter((f) => f.ownNote !== null && f.ownNote.trim())
        .length,
      model: modelKind(brain, d.model),
      overridden: d.model !== null,
    });
    const title = text ? titleFor(d.title, text) : '';
    const rows = d.files.map((f) => {
      const n = (f.ownNote ?? d.note).trim();
      return n
        ? { path: f.path, type: f.type, note: n }
        : { path: f.path, type: f.type };
    });
    setAdding(true);
    const [textResult, fileResults] = await Promise.all([
      text
        ? tryInvoke(
            () =>
              api().invoke(
                'brain:addText',
                ...args(brainId, text, title, d.textType, note, model),
              ),
            notify,
          )
        : Promise.resolve(null),
      rows.length
        ? tryInvoke(
            () => api().invoke('brain:addFiles', ...args(brainId, rows, model)),
            notify,
          )
        : Promise.resolve([] as AddSourceResult[]),
    ]);
    setAdding(false);
    const textIn = textResult?.ok === true;
    const textStays = !!text && !textIn;
    const sent = new Set<string>();
    (fileResults ?? []).forEach((r, i) => {
      if (r.ok) sent.add(rows[i].path);
    });
    const filesStay = d.files.some((f) => !sent.has(f.path));
    const failed: string[] = [];
    if (textResult && !textResult.ok) failed.push(textResult.message);
    for (const r of fileResults ?? []) if (!r.ok) failed.push(r.message);
    setProblems(failed);
    const sources = addedOf([
      ...(textResult ? [textResult] : []),
      ...(fileResults ?? []),
    ]);
    setAdded(
      textIn || sent.size
        ? { title: textIn ? title : null, files: sent.size, sources }
        : null,
    );
    if (!textStays && !filesStay) {
      clear();
      return true;
    }
    update((cur) => ({
      ...cur,
      text: textStays ? cur.text : '',
      title: textStays ? cur.title : '',
      textType: textStays ? cur.textType : 'note',
      files: cur.files.filter((f) => !sent.has(f.path)),
    }));
    return false;
  };

  const discard = () => {
    trackBrain('discard');
    clear();
    setProblems([]);
  };

  const setText = (text: string) => update({ text });
  const setTitle = (title: string) => update({ title });
  const setNote = (note: string) => update({ note });
  const setTextType = (textType: SourceType) => update({ textType });
  const setModel = (model: string | null) => update({ model });

  return {
    draft,
    isEmpty,
    problems,
    adding,
    added,
    dismissAdded: () => setAdded(null),
    addFiles,
    setFile,
    removeFile,
    setText,
    setTitle,
    setNote,
    setTextType,
    setModel,
    add,
    discard,
  };
}

export type ComposerState = ReturnType<typeof useComposer>;
