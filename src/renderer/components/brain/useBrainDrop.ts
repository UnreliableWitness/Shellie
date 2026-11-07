import { useState, type DragEvent } from 'react';
import type { AddSourceResult, SourceType } from '../../../shared/brain';
import { api, tryInvoke } from '../../api';
import { useStore, type BrainPendingFile } from '../../store';
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

export type PendingFile = BrainPendingFile;

const failures = (results: AddSourceResult[]) =>
  results.flatMap((r) => (r.ok ? [] : [r.message]));

/** A file that went in: its source, its picture counts, and its lines (what it holds, then each converter warning). */
export type AddedSource = {
  path: string;
  images: number;
  dropped: number;
  lines: string[];
};

/** What each added file brought: `Added <name> · <contents>`, then its warnings. */
export const addedOf = (results: AddSourceResult[]): AddedSource[] =>
  results.flatMap((r) => {
    if (!r.ok) return [];
    const name = r.path.replace(/^sources\//, '');
    return [
      {
        path: r.path,
        images: r.images,
        dropped: r.dropped,
        lines: [
          `Added ${name}${r.contents ? ` · ${r.contents}` : ''}`,
          ...r.warnings.map((w) => `${name}: ${w}`),
        ],
      },
    ];
  });

const EMPTY: PendingFile[] = [];

/**
 * Files dropped (or chosen) for a brain wait in `pending` (kept in the store per brain, so they survive a tab or
 * screen switch), each with a type and a note the person can set, until `add` sends them to `brain:addFiles`.
 * `dropProps` go on the drop target, `over` is true while a drag is above it, `problems` are what could not be
 * added, `added` what was added and what its conversion left out.
 */
export function useBrainDrop(brainId: string) {
  const notify = useStore((s) => s.notify);
  const pending = useStore((s) => s.brainPending[brainId] ?? EMPTY);
  const setBrainPending = useStore((s) => s.setBrainPending);
  const setPending = (update: (p: PendingFile[]) => PendingFile[]) =>
    setBrainPending(brainId, update);
  const [over, setOver] = useState(false);
  const [adding, setAdding] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [added, setAdded] = useState<AddedSource[]>([]);

  /** Queues files; a path already waiting is not queued twice, a File with no path on disk is reported. */
  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    trackBrain('drop');
    const named = files.map((f) => ({
      name: f.name,
      path: api().pathForFile(f),
    }));
    const noPath = named.filter((f) => !f.path);
    setPending((p) => {
      const have = new Set(p.map((f) => f.path));
      const next = [...p];
      for (const f of named) {
        if (!f.path || have.has(f.path)) continue;
        have.add(f.path);
        next.push({ ...f, type: guessType(f.name), note: '' });
      }
      return next;
    });
    if (noPath.length)
      setProblems(
        noPath.map((f) => `${f.name || 'A file'}: not a file on disk`),
      );
  };
  const setType = (path: string, type: SourceType) =>
    setPending((p) => p.map((f) => (f.path === path ? { ...f, type } : f)));
  const setNote = (path: string, note: string) =>
    setPending((p) => p.map((f) => (f.path === path ? { ...f, note } : f)));
  const remove = (path: string) =>
    setPending((p) => p.filter((f) => f.path !== path));

  /**
   * Sends every pending file. Only the files sent leave the list when main answered (files dropped meanwhile stay);
   * the whole list stays when the call itself failed.
   */
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
    const sent = new Set(rows.map((r) => r.path));
    setPending((p) => p.filter((f) => !sent.has(f.path)));
    setProblems(failures(results));
    setAdded(addedOf(results));
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
    added,
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
