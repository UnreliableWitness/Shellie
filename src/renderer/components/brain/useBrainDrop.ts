import { useState, type DragEvent } from 'react';
import type { AddSourceResult, SourceType } from '../../../shared/brain';
import { api, tryInvoke } from '../../api';
import { useStore } from '../../store';
import { trackBrain } from './brainActions';

/** The same rule as main's `guessSourceType`: by extension, not by content. */
export const guessType = (name: string): SourceType =>
  /\.vtt$/i.test(name) ? 'transcript' : /\.pptx$/i.test(name) ? 'deck' : 'doc';

const failures = (results: AddSourceResult[]) =>
  results.flatMap((r) => (r.ok ? [] : [r.message]));

/**
 * Files dropped (or chosen) for a brain go to `brain:addFiles`: `dropProps` go on the drop target, `over` is true
 * while a drag is above it, `problems` are what could not be added.
 */
export function useBrainDrop(brainId: string) {
  const notify = useStore((s) => s.notify);
  const [over, setOver] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    trackBrain('drop');
    const rows = files.map((f) => ({
      path: api().pathForFile(f),
      type: guessType(f.name),
    }));
    const results = await tryInvoke(
      () => api().invoke('brain:addFiles', brainId, rows),
      notify,
    );
    setProblems(results ? failures(results) : []);
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
      void addFiles(Array.from(e.dataTransfer.files));
    },
  };

  return { over, problems, setProblems, addFiles, dropProps };
}
