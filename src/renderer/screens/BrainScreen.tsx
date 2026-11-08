import { useState } from 'react';
import type { TerminalDef } from '../../shared/types';
import { brainTaskId, picturesReady } from '../../shared/brain';
import { api, tryInvoke } from '../api';
import { AskBox } from '../components/brain/AskBox';
import { BrainAdd } from '../components/brain/BrainAdd';
import { BrainRead } from '../components/brain/BrainRead';
import { trackBrain } from '../components/brain/brainActions';
import { useBrainPages } from '../components/brain/BrainWiki';
import { badgeCount } from '../components/brain/waiting';
import { PageHeader, PopupMenu } from '../components/ui';
import { TerminalView } from '../components/TerminalView';
import { useBrain } from '../hooks/useBrains';
import { local } from '../localStorage';
import { useStore } from '../store';

type View = 'read' | 'add';

const LAST_OPENED = (brainId: string) => `brain-last-opened:${brainId}`;
const VIEW = (brainId: string) => `shellie.brain.view.${brainId}`;

/** When this brain was last opened (a convenience in localStorage), and marks now: read once per Brain screen mount. */
function useLastOpened(brainId: string): string | null {
  const [last] = useState<string | null>(() => {
    try {
      const storage = local();
      const prev = storage?.getItem(LAST_OPENED(brainId)) ?? null;
      storage?.setItem(LAST_OPENED(brainId), new Date().toISOString());
      return prev;
    } catch {
      return null;
    }
  });
  return last;
}

/** The view to open on: `focus` decides when it names one, else the one last chosen for this brain, else Read. */
function initialView(brainId: string, focus?: 'ask' | 'wiki' | 'drop'): View {
  if (focus === 'wiki') return 'read';
  if (focus === 'drop') return 'add';
  try {
    return local()?.getItem(VIEW(brainId)) === 'add' ? 'add' : 'read';
  } catch {
    return 'read';
  }
}

/** One brain: a Read | Add switch over its pages and its feeding, the Ask box, and its terminal below. */
export function BrainScreen({
  brainId,
  focus,
}: {
  brainId: string;
  focus?: 'ask' | 'wiki' | 'drop';
}) {
  const brain = useBrain(brainId);
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const [view, setView] = useState<View>(() => initialView(brainId, focus));
  const [openRequest, setOpenRequest] = useState<{
    path: string;
    n: number;
  } | null>(null);
  const [terminal, setTerminal] = useState<TerminalDef | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreButton, setMoreButton] = useState<HTMLButtonElement | null>(null);
  const since = useLastOpened(brainId);
  const pages = useBrainPages(brainId);

  if (!brain)
    return (
      <div className="page">
        <PageHeader title="Brain" />
        <div className="page-body">
          <p className="muted">Loading</p>
        </div>
      </div>
    );

  const choose = (next: View) => {
    if (next === view) return;
    trackBrain(next === 'read' ? 'view-read' : 'view-add');
    setView(next);
    try {
      local()?.setItem(VIEW(brain.id), next);
    } catch {
      // A convenience: the view is chosen again next time.
    }
  };
  const openPage = (path: string) => {
    choose('read');
    setOpenRequest((r) => ({ path, n: (r?.n ?? 0) + 1 }));
  };
  const closeTerminal = async (id: string) => {
    trackBrain('close-terminal');
    setTerminal(null);
    await tryInvoke(() => api().invoke('terminals:kill', id), notify);
  };
  const waiting = badgeCount(pages.sources, brain.jobs);

  return (
    <div className="page brain-page">
      <PageHeader
        title={brain.name}
        after={
          <>
            <span className="muted">{brain.project}</span>
            <div className="brain-switch" role="tablist" aria-label="View">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'read'}
                className={view === 'read' ? 'is-on' : undefined}
                onClick={() => choose('read')}
              >
                Read
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'add'}
                aria-label={waiting > 0 ? `Add, ${waiting} waiting` : 'Add'}
                className={view === 'add' ? 'is-on' : undefined}
                onClick={() => choose('add')}
              >
                Add
                {waiting > 0 && (
                  <span className="brain-switch-badge">{waiting}</span>
                )}
              </button>
            </div>
          </>
        }
        inline
        commands={
          <>
            <AskBox
              brainId={brain.id}
              agent={brain.options.agent}
              onTerminal={setTerminal}
              initiallyOpen={focus === 'ask'}
            />
            <button
              ref={setMoreButton}
              type="button"
              className="btn btn-sm"
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              ⋯
            </button>
            <PopupMenu
              label="More"
              anchor={moreButton}
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
            >
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  void tryInvoke(
                    () => api().invoke('brain:openFolder', brain.id),
                    notify,
                  );
                }}
              >
                Open folder
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  go({
                    kind: 'settings',
                    scope: 'project',
                    connectionId: brain.connectionId,
                    section: 'project-brains',
                  });
                }}
              >
                Brain settings
              </button>
            </PopupMenu>
          </>
        }
      />
      <div className="brain-body">
        {/* Both views stay mounted, so the open page and a half-filled form survive a switch. */}
        <div className="brain-view brain-view-read" hidden={view !== 'read'}>
          <BrainRead
            brainId={brain.id}
            brainName={brain.name}
            pages={pages}
            since={since}
            openRequest={openRequest}
            active={view === 'read'}
            jobs={brain.jobs}
            skillsReady={picturesReady(brain)}
          />
        </div>
        <div className="brain-view brain-view-add" hidden={view !== 'add'}>
          <BrainAdd
            brain={brain}
            pages={pages}
            onTerminal={setTerminal}
            onOpenPage={openPage}
            focusChoose={focus === 'drop'}
          />
        </div>
        {terminal && (
          <div className="brain-terminal">
            <div className="brain-terminal-bar">
              <span className="small muted">{terminal.label}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void closeTerminal(terminal.id)}
              >
                Close
              </button>
            </div>
            <TerminalView
              key={terminal.id}
              terminalId={terminal.id}
              taskId={brainTaskId(brain.id)}
              active
              resumes
              autoStart
            />
          </div>
        )}
      </div>
    </div>
  );
}
