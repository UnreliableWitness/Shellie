import { useCallback, useEffect, useState } from 'react';
import type { BrainView } from '../../../shared/brain';
import { api } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { useStore } from '../../store';
import { MarkdownView } from '../docs/MarkdownView';
import { BrainFiles } from './BrainFiles';
import { useBrainDrop } from './useBrainDrop';

/** A task's Brain tab: the brain's index, its wiki pages (filtered by name), and a drop target for new sources. */
export function BrainTab({ brain }: { brain: BrainView }) {
  const go = useStore((s) => s.go);
  const [index, setIndex] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const { over, problems, dropProps } = useBrainDrop(brain.id);

  const load = useCallback(() => {
    api()
      .invoke('brain:read', brain.id, 'index.md')
      .then(
        (r) => setIndex(r.text),
        () => setIndex(''),
      );
  }, [brain.id]);
  useEffect(load, [load]);
  useBrainChanged(brain.id, load);
  const asset = useCallback(
    (path: string) => api().invoke('brain:asset', brain.id, path),
    [brain.id],
  );

  return (
    <div
      className={over ? 'brain-tab is-over' : 'brain-tab'}
      data-dropzone
      aria-label={`${brain.name} brain, drop files to add them`}
      {...dropProps}
    >
      <div className="brain-tab-head">
        <strong>{brain.name}</strong>
        <button
          type="button"
          className="link small"
          onClick={() => go({ kind: 'brain', brainId: brain.id })}
        >
          Open brain
        </button>
        <span className="muted small">Drop files here to add them</span>
      </div>
      {problems.length > 0 && (
        <ul className="brain-problems small" role="alert">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {index && index.trim() !== '' && (
        <div className="brain-tab-index brain-doc">
          <MarkdownView
            asset={asset}
            path="index.md"
            text={index}
            onOpenDoc={() => undefined}
            onOpenFile={() => undefined}
          />
        </div>
      )}
      <input
        className="field"
        aria-label="Filter pages"
        placeholder="Filter pages"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <BrainFiles brainId={brain.id} dir="wiki" filter={filter} />
    </div>
  );
}
