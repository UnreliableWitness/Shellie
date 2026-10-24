import { useEffect, useState } from 'react';
import type { Notice } from '../../shared/types';
import type { PendingUpdate } from '../../shared/ipc';
import { api, tryInvoke } from '../api';
import { useStore } from '../store';
import { track } from '../telemetry';

/** A downloaded update, offered once per launch in the notice corner: no dialog, nothing to click unless wanted. */
function UpdateNotice() {
  const notify = useStore((s) => s.notify);
  const [update, setUpdate] = useState<PendingUpdate | null>(null);
  /** Later hides the card for that version only: a newer download (checks go on, #126) shows it again. */
  const [dismissed, setDismissed] = useState<PendingUpdate | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const off = api().on('update:ready', (u) => setUpdate(u));
    // The download may have finished before this window subscribed.
    void api()
      .invoke('update:status')
      .then((u) => {
        if (live && u) setUpdate(u);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      off();
    };
  }, []);

  if (!update || (dismissed && dismissed.version === update.version))
    return null;
  const name = update.version
    ? `Shellie ${update.version}`
    : 'A new version of Shellie';
  const restart = async () => {
    setBusy(true);
    const ok = await tryInvoke(async () => {
      await api().invoke('update:install');
      return true;
    }, notify);
    if (!ok) setBusy(false);
  };
  return (
    <div className="notice notice-update">
      <div className="notice-update-body">
        <strong>{name} is ready</strong>
        <span className="muted small">
          Restart to update now, or it installs the next time Shellie starts.
          Terminals close; Claude Code resumes its sessions after the restart.
        </span>
        <div className="notice-update-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={restart}
            disabled={busy}
          >
            Restart and update
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              track('update.later');
              setDismissed(update);
            }}
            disabled={busy}
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}

/** macOS builds update only from /Applications: offers to move the app there, once per launch. */
function MoveNotice() {
  const notify = useStore((s) => s.notify);
  const [needsMove, setNeedsMove] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api()
      .invoke('update:needsMove')
      .then((v) => {
        if (live && v === true) setNeedsMove(true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!needsMove || dismissed) return null;
  const move = async () => {
    track('update.move');
    setBusy(true);
    const started = await tryInvoke(
      () => api().invoke('update:moveToApplications'),
      notify,
    );
    // On success Electron relaunches from /Applications; a refusal leaves the card for another try.
    if (!started) setBusy(false);
  };
  return (
    <div className="notice notice-update">
      <div className="notice-update-body">
        <strong>Move Shellie to Applications to get updates</strong>
        <span className="muted small">
          Shellie can only update itself from the Applications folder. It
          restarts from there.
        </span>
        <div className="notice-update-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={move}
            disabled={busy}
          >
            Move
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              track('update.moveLater');
              setDismissed(true);
            }}
            disabled={busy}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

export const NOTICE_MS = { info: 6000, warn: 10000, error: 12000 } as const;
/** Messages longer than this get a 4-line clamp and a Show all toggle. */
export const LONG_NOTICE = 200;

function NoticeItem({ notice }: { notice: Notice }) {
  const dismiss = useStore((s) => s.dismiss);
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const long = notice.message.length > LONG_NOTICE;

  useEffect(() => {
    if (paused || expanded) return;
    const t = setTimeout(() => dismiss(notice.id), NOTICE_MS[notice.level]);
    return () => clearTimeout(t);
  }, [paused, expanded, notice.id, notice.level, dismiss]);

  return (
    <div
      className={`notice notice-${notice.level}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') dismiss(notice.id);
      }}
    >
      <div className="notice-text">
        <span
          className={`notice-message${long && !expanded ? ' notice-clamped' : ''}`}
        >
          {notice.message}
        </span>
        {long && (
          <button
            type="button"
            className="notice-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
      <button
        type="button"
        className="notice-close"
        aria-label="Dismiss"
        onClick={() => dismiss(notice.id)}
      >
        &times;
      </button>
    </div>
  );
}

export function Notices() {
  const notices = useStore((s) => s.notices);
  return (
    <div className="notices" role="status">
      {notices.map((n) => (
        <NoticeItem key={n.id} notice={n} />
      ))}
      <UpdateNotice />
      <MoveNotice />
    </div>
  );
}
