import { useEffect, useRef, useState } from 'react';
import type { TerminalDef } from '../../shared/types';
import { brainTaskId, picturesReady, writeReady } from '../../shared/brain';
import { api, tryInvoke } from '../api';
import { AskBox } from '../components/brain/AskBox';
import { BrainAdd } from '../components/brain/BrainAdd';
import { BrainRead } from '../components/brain/BrainRead';
import { ShareDialog } from '../components/brain/ShareDialog';
import { SharedStatus } from '../components/brain/SharedStatus';
import { trackBrain, trackSettleOpen } from '../components/brain/brainActions';
import { useBrainPages } from '../components/brain/BrainWiki';
import { SettleView } from '../components/brain/settle/SettleView';
import { useBrainConflicts } from '../components/brain/settle/useBrainConflicts';
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
  open,
}: {
  brainId: string;
  focus?: 'ask' | 'wiki' | 'drop';
  /** A page, long read or letter the route asks the Read view to open; another `n` opens it again. */
  open?: { path: string; n: number };
}) {
  const brain = useBrain(brainId);
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const [view, setView] = useState<View>(() =>
    open ? 'read' : initialView(brainId, focus),
  );
  const [openRequest, setOpenRequest] = useState<{
    path: string;
    n: number;
  } | null>(open ? { path: open.path, n: 1 } : null);
  // The route asks again while the screen is up (a notice, clicked on this brain's page).
  const asked = useRef(open?.n);
  useEffect(() => {
    if (!open || asked.current === open.n) return;
    asked.current = open.n;
    setView('read');
    setOpenRequest((r) => ({ path: open.path, n: (r?.n ?? 0) + 1 }));
  }, [open]);
  const [terminal, setTerminal] = useState<TerminalDef | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreButton, setMoreButton] = useState<HTMLButtonElement | null>(null);
  const since = useLastOpened(brainId);
  const pages = useBrainPages(brainId);
  const { conflicts } = useBrainConflicts(brainId);
  // The Settle view, shown in place of Add: at one conflict (target) or its list (null).
  const [settle, setSettle] = useState<{ target: string | null } | null>(null);
  const [sharing, setSharing] = useState(false);
  // A shared brain pulls when its page opens.
  const isShared = brain?.sharing != null;
  useEffect(() => {
    if (isShared)
      api()
        .invoke('brain:syncNow', brainId)
        .catch(() => undefined);
  }, [brainId, isShared]);

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
  const openSettle = (
    target: string | null,
    from: 'add' | 'health' | 'read',
  ) => {
    trackSettleOpen(from);
    setSettle({ target });
    choose('add');
  };
  const waiting =
    badgeCount(pages.sources, brain.jobs, conflicts.answers) +
    conflicts.open.length;

  return (
    <div className="page brain-page">
      <PageHeader
        title={brain.name}
        after={
          <>
            <span className="muted">{brain.project}</span>
            <SharedStatus brain={brain} />
            <div className="brain-switch" role="tablist" aria-label="View">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'read'}
                className={view === 'read' ? 'is-on' : undefined}
                onClick={() => {
                  setSettle(null);
                  choose('read');
                }}
              >
                Read
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'add'}
                aria-label={waiting > 0 ? `Add, ${waiting} waiting` : 'Add'}
                className={view === 'add' ? 'is-on' : undefined}
                onClick={() => {
                  setSettle(null);
                  choose('add');
                }}
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
            {brain.sharing ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  void tryInvoke(async () => {
                    const link = await api().invoke('brain:joinLink', brain.id);
                    await navigator.clipboard.writeText(link);
                    notify('info', 'Join link copied');
                  }, notify)
                }
              >
                Copy join link
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setSharing(true)}
              >
                Share with colleagues
              </button>
            )}
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
        {sharing && (
          <ShareDialog
            brain={brain}
            onClose={() => setSharing(false)}
            onSources={() => {
              setSharing(false);
              setSettle(null);
              choose('add');
            }}
          />
        )}
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
            canWrite={writeReady(brain)}
            shared={brain.sharing !== null}
            conflicts={conflicts.open}
            onSettle={(id) => openSettle(id, 'read')}
          />
        </div>
        <div className="brain-view brain-view-add" hidden={view !== 'add'}>
          {settle && (
            <SettleView
              brain={brain}
              conflicts={conflicts}
              rows={pages.rows}
              target={settle.target}
              onTarget={(target) => setSettle({ target })}
              onBack={() => setSettle(null)}
              onOpenPage={openPage}
            />
          )}
          {/* Add stays mounted under the Settle view, so its draft and drop state survive. */}
          <div className="brain-view-add-body" hidden={settle !== null}>
            <BrainAdd
              brain={brain}
              pages={pages}
              onTerminal={setTerminal}
              onOpenPage={openPage}
              focusChoose={focus === 'drop'}
              conflicts={conflicts}
              onSettle={(id, from) => openSettle(id, from)}
            />
          </div>
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
