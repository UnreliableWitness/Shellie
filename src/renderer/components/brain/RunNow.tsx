import type { BrainView } from '../../../shared/brain';
import type { TerminalDef } from '../../../shared/types';
import { api, tryInvoke } from '../../api';
import { useStore } from '../../store';
import { HelpTip } from '../ui';
import { openBrainTerminal, refreshWiki, trackBrain } from './brainActions';

const HELP = {
  refresh:
    "Copies the latest pages of the linked Azure DevOps wiki into the brain's sources. No tokens. Runs by itself once a day while Shellie is open.",
  lint: 'Checks the wiki for broken links, contradictions, stale and orphan pages; findings show under Health. Uses tokens. Runs by itself after every successful capture.',
  sync: 'Compares what changed in the sources and the wiki since the last sync and updates the pages that cite it. Use it after editing pages by hand or after a large wiki refresh. Uses tokens and takes a few minutes.',
  digest:
    'Writes a summary page of what changed in the last week. Uses tokens.',
  terminal:
    'An agent session in the brain folder, for questions or edits by hand.',
};

/** A command and its `?`, side by side (the `?` is its own button). */
function Command({
  label,
  help,
  onClick,
}: {
  label: string;
  help: string;
  onClick: () => void;
}) {
  return (
    <span className="brain-run-cmd">
      <button type="button" className="btn btn-sm" onClick={onClick}>
        {label}
      </button>
      <HelpTip label={label} onOpen={() => trackBrain('help')}>
        {help}
      </HelpTip>
    </span>
  );
}

/** The brain's runs on demand, each with a `?` saying what it does and what it costs. */
export function RunNow({
  brain,
  onTerminal,
}: {
  brain: BrainView;
  onTerminal?: (def: TerminalDef) => void;
}) {
  const notify = useStore((s) => s.notify);
  const run = (kind: 'lint' | 'sync' | 'digest') => {
    trackBrain(kind);
    void tryInvoke(() => api().invoke('brain:run', brain.id, kind), notify);
  };
  const openTerminal = async () => {
    trackBrain('terminal');
    const def = await openBrainTerminal(brain.id, notify);
    if (def) onTerminal?.(def);
  };
  return (
    <section className="brain-card" aria-labelledby="brain-run-h">
      <div className="brain-card-head">
        <h2 id="brain-run-h">Run now</h2>
        <span className="tag tag-muted">manual</span>
      </div>
      <div className="brain-run">
        {brain.wiki && (
          <Command
            label="Refresh wiki"
            help={HELP.refresh}
            onClick={() => void refreshWiki(brain.id, notify)}
          />
        )}
        <Command label="Lint" help={HELP.lint} onClick={() => run('lint')} />
        <Command label="Sync" help={HELP.sync} onClick={() => run('sync')} />
        <Command
          label="Digest"
          help={HELP.digest}
          onClick={() => run('digest')}
        />
        <Command
          label="Open terminal"
          help={HELP.terminal}
          onClick={() => void openTerminal()}
        />
      </div>
    </section>
  );
}
