import { type DragEvent, useState } from 'react';
import type { BrainConflicts, BrainView } from '../../../shared/brain';
import type { TerminalDef } from '../../../shared/types';
import { AutoRuns } from './AutoRuns';
import { BrainHealth } from './BrainHealth';
import type { BrainPages } from './BrainWiki';
import { Activity } from './composer/Activity';
import { Composer } from './composer/Composer';
import { useComposer } from './composer/useComposer';
import { RunNow } from './RunNow';
import { NO_CONFLICTS } from './settle/useBrainConflicts';

const hasFiles = (e: DragEvent) =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * The Add view. Left, the composer (text, files, one note, one Add) and Activity (what runs, what needs you, what
 * finished). Right, what runs by itself, Run now and Health. The whole view takes dropped files.
 */
export function BrainAdd({
  brain,
  onTerminal,
  onOpenPage,
  pages,
  focusChoose = false,
  conflicts = NO_CONFLICTS,
  onSettle,
}: {
  brain: BrainView;
  /** The brain's pages, sources and log, loaded once by the screen. */
  pages: BrainPages;
  onTerminal?: (def: TerminalDef) => void;
  /** Switches to Read and opens the page. */
  onOpenPage: (path: string) => void;
  /** Put the cursor on Attach files once mounted (a deep link to adding files). */
  focusChoose?: boolean;
  /** The brain's conflicts: a Needs you row, and answers kept out of the waiting sources. */
  conflicts?: BrainConflicts;
  /** Opens the Settle view, at one conflict or its list. */
  onSettle?: (id: string | null, from: 'add' | 'health') => void;
}) {
  const composer = useComposer(brain);
  const [expanded, setExpanded] = useState(true);
  const [dropping, setDropping] = useState<{ count: number } | null>(null);
  const { rows, sources, log } = pages;
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!dropping) setDropping({ count: e.dataTransfer.items?.length ?? 0 });
    },
    onDragLeave: (e: DragEvent) => {
      // Leaving for a child of the view is not leaving the view.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null))
        setDropping(null);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(null);
      setExpanded(true);
      void composer.addFiles(Array.from(e.dataTransfer.files));
    },
  };
  return (
    <div className="brain-add" {...dropProps}>
      <div className="brain-add-main">
        <Composer
          brain={brain}
          composer={composer}
          expanded={expanded}
          onExpand={() => setExpanded(true)}
          onAdded={() => setExpanded(false)}
          dropping={dropping}
          focusAttach={focusChoose}
        />
        <Activity
          brain={brain}
          sources={sources}
          rows={rows}
          log={log}
          onTerminal={onTerminal}
          onOpenPage={onOpenPage}
          conflicts={conflicts.open.length}
          parkedConflicts={conflicts.parked.length}
          answers={conflicts.answers}
          onSettle={onSettle ? () => onSettle(null, 'add') : undefined}
        />
      </div>
      <div className="brain-add-side">
        <AutoRuns brain={brain} />
        <RunNow brain={brain} onTerminal={onTerminal} />
        <BrainHealth
          brain={brain}
          onTerminal={onTerminal}
          onOpen={onOpenPage}
          onSettle={onSettle ? (id) => onSettle(id, 'health') : undefined}
        />
      </div>
    </div>
  );
}
