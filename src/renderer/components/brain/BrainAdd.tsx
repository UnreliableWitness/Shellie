import type { BrainView } from '../../../shared/brain';
import type { TerminalDef } from '../../../shared/types';
import { AddToBrain, RecentWork, WaitingToCapture } from './BrainInbox';
import { useBrainPages } from './BrainWiki';
import { HowItWorks } from './HowItWorks';
import { useBrainDrop } from './useBrainDrop';

/** The Add view's feeding column: how it works, the drop zone and paste form, what waits to be captured, and recent work. The whole view takes drops. */
export function BrainAdd({
  brain,
  onTerminal,
  onOpenPage,
  focusChoose = false,
}: {
  brain: BrainView;
  onTerminal?: (def: TerminalDef) => void;
  /** Switches to Read and opens the page. */
  onOpenPage: (path: string) => void;
  /** Put the cursor on Choose files once mounted (a deep link to the drop zone). */
  focusChoose?: boolean;
}) {
  const drop = useBrainDrop(brain.id);
  const { rows, sources, log } = useBrainPages(brain.id);
  return (
    <div className="brain-add" {...drop.dropProps}>
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
  );
}
