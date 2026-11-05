import { useState, type DragEvent } from 'react';
import type { AddSourceResult, SourceType } from '../../../shared/brain';
import { api, tryInvoke } from '../../api';
import { useStore } from '../../store';
import { trackBrain } from './brainActions';

/** The same rule as main's `guessSourceType`: by extension, not by content. */
export const guessType = (name: string): SourceType =>
  /\.vtt$/i.test(name) ? 'transcript' : /\.pptx$/i.test(name) ? 'deck' : 'doc';

/** The types a person can give a dropped file or pasted text. */
export const SOURCE_TYPES: SourceType[] = [
  'doc',
  'note',
  'transcript',
  'deck',
  'sow',
];

/** A dropped file waiting for its type and note before it goes into the brain. */
export type PendingFile = {
  path: string;
  name: string;
  type: SourceType;
  note: string;
};

const failures = (results: AddSourceResult[]) =>
  results.flatMap((r) => (r.ok ? [] : [r.message]));

/** One line per added file, with what it holds, then each converter warning. */
export const notesOf = (results: AddSourceResult[]) =>
  results.flatMap((r) => {
    if (!r.ok) return [];
    const name = r.path.replace(/^sources\//, '');
    return [
      `Added ${name}${r.contents ? ` · ${r.contents}` : ''}`,
      ...r.warnings.map((w) => `${name}: ${w}`),
    ];
  });

/**
 * Files dropped (or chosen) for a brain wait in `pending`, each with a type and a note the person can set, until
 * `add` sends them to `brain:addFiles`. `dropProps` go on the drop target, `over` is true while a drag is above it,
 * `problems` are what could not be added, `notes` what was added and what its conversion left out.
 */
export function useBrainDrop(brainId: string) {
  const notify = useStore((s) => s.notify);
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [adding, setAdding] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);

  /** Queues files; a path already waiting is not queued twice. */
  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    trackBrain('drop');
    setPending((p) => {
      const have = new Set(p.map((f) => f.path));
      const next = [...p];
      for (const f of files) {
        const path = api().pathForFile(f);
        if (have.has(path)) continue;
        have.add(path);
        next.push({ path, name: f.name, type: guessType(f.name), note: '' });
      }
      return next;
    });
  };
  const setType = (path: string, type: SourceType) =>
    setPending((p) => p.map((f) => (f.path === path ? { ...f, type } : f)));
  const setNote = (path: string, note: string) =>
    setPending((p) => p.map((f) => (f.path === path ? { ...f, note } : f)));
  const remove = (path: string) =>
    setPending((p) => p.filter((f) => f.path !== path));

  /** Sends every pending file; the list is cleared when main answered, kept when the call itself failed. */
  const add = async () => {
    if (pending.length === 0 || adding) return;
    trackBrain('add');
    const rows = pending.map((f) => {
      const note = f.note.trim();
      return note
        ? { path: f.path, type: f.type, note }
        : { path: f.path, type: f.type };
    });
    setAdding(true);
    const results = await tryInvoke(
      () => api().invoke('brain:addFiles', brainId, rows),
      notify,
    );
    setAdding(false);
    if (!results) return;
    setPending([]);
    setProblems(failures(results));
    setNotes(notesOf(results));
  };

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      addFiles(Array.from(e.dataTransfer.files));
    },
  };

  return {
    over,
    problems,
    setProblems,
    notes,
    pending,
    adding,
    addFiles,
    setType,
    setNote,
    remove,
    add,
    dropProps,
  };
}

export type BrainDrop = ReturnType<typeof useBrainDrop>;
