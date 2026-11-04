import { useCallback, useEffect, useState } from 'react';
import type { BrainView } from '../../../shared/brain';
import type { TerminalDef } from '../../../shared/types';
import { api } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { useStore } from '../../store';
import { AskBox } from './AskBox';
import { BrainPage } from './BrainPage';
import { BrainSearch } from './BrainSearch';
import { useBrainPages } from './BrainWiki';
import { PageCard, PageSections } from './PageCards';
import { useBrainDrop } from './useBrainDrop';
import { useBrainNav } from './useBrainNav';

/**
 * A task's Brain tab: ask the brain, search it, the pages that matter for this task, every page in a compact list,
 * a page opened in place; the whole tab takes dropped files as new sources.
 */
export function BrainTab({
  brain,
  taskId,
  onTerminal,
}: {
  brain: BrainView;
  taskId: string;
  onTerminal: (def: TerminalDef) => void;
}) {
  const go = useStore((s) => s.go);
  const { over, problems, notes, dropProps } = useBrainDrop(brain.id);
  const { rows, sources } = useBrainPages(brain.id);
  const nav = useBrainNav();
  const [searching, setSearching] = useState(false);
  const [relevant, setRelevant] = useState<string[]>([]);
  const loadRelevant = useCallback(() => {
    api()
      .invoke('brain:relevant', brain.id, taskId)
      .then(setRelevant, () => setRelevant([]));
  }, [brain.id, taskId]);
  useEffect(loadRelevant, [loadRelevant]);
  useBrainChanged(brain.id, loadRelevant);
  const open = useCallback(
    (path: string, anchor?: string) => nav.open(path, anchor),
    [nav],
  );
  const relevantRows = relevant
    .map((p) => rows.find((r) => r.path === p))
    .filter((r): r is NonNullable<typeof r> => !!r);

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
      {notes.length > 0 && (
        <ul className="brain-notes muted small" aria-label="Added">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {nav.current ? (
        <BrainPage
          brainId={brain.id}
          path={nav.current.path}
          anchor={nav.current.anchor}
          rows={rows}
          sources={sources}
          canBack={nav.canBack}
          canForward={nav.canForward}
          onOpen={open}
          onBack={nav.back}
          onForward={nav.forward}
        />
      ) : (
        <>
          <AskBox brainId={brain.id} onTerminal={onTerminal} />
          <BrainSearch
            brainId={brain.id}
            onOpen={open}
            onActive={setSearching}
          />
          {!searching && (
            <>
              <section className="brain-section" aria-label="For this task">
                <h3>For this task</h3>
                {relevantRows.length ? (
                  <div className="brain-card-grid">
                    {relevantRows.map((r) => (
                      <PageCard key={r.path} row={r} onOpen={open} />
                    ))}
                  </div>
                ) : (
                  <p className="muted small">No page mentions this task yet.</p>
                )}
              </section>
              <PageSections rows={rows} compact onOpen={open} />
            </>
          )}
        </>
      )}
    </div>
  );
}
