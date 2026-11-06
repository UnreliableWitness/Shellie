import type { BrainView } from '../../../shared/brain';
import type { TerminalDef } from '../../../shared/types';
import { AutoRuns } from './AutoRuns';
import { BrainHealth } from './BrainHealth';
import { AddToBrain, RecentWork, WaitingToCapture } from './BrainInbox';
import type { BrainPages } from './BrainWiki';
import { HowItWorks } from './HowItWorks';
import { RunNow } from './RunNow';
import { useBrainDrop } from './useBrainDrop';

/**
 * The Add view. Left, feeding the brain: how it works, the drop zone and paste form, what waits to be captured,
 * and recent work. Right, what runs by itself, Run now and Health. The whole view takes drops.
 */
export function BrainAdd({
  brain,
  onTerminal,
  onOpenPage,
  pages,
  focusChoose = false,
}: {
  brain: BrainView;
  /** The brain's pages, sources and log, loaded once by the screen. */
  pages: BrainPages;
  onTerminal?: (def: TerminalDef) => void;
  /** Switches to Read and opens the page. */
  onOpenPage: (path: string) => void;
  /** Put the cursor on Choose files once mounted (a deep link to the drop zone). */
  focusChoose?: boolean;
}) {
  const drop = useBrainDrop(brain.id);
  const { rows, sources, log } = pages;
  return (
    <div className="brain-add" {...drop.dropProps}>
      <div className="brain-add-main">
        <HowItWorks />
        <AddToBrain brain={brain} drop={drop} focusChoose={focusChoose} />
        <WaitingToCapture brain={brain} sources={sources} />
        <RecentWork
          brain={brain}
          rows={rows}
          log={log}
          onTerminal={onTerminal}
          onOpenPage={onOpenPage}
        />
      </div>
      <div className="brain-add-side">
        <AutoRuns brain={brain} />
        <RunNow brain={brain} onTerminal={onTerminal} />
        <BrainHealth brain={brain} onTerminal={onTerminal} />
      </div>
    </div>
  );
}
