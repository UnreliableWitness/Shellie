import { WeatherMoon12Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useClock } from '../../hooks/useClock';
import { useStore } from '../../store';
import { minutesSince, navLine, stepLine } from './dreamWords';
import { UsageBar } from './UsageBar';
import { useDreamsState } from './useDreams';

/**
 * The dream line at the foot of the navigation. A click opens Dreams; while a dream runs it opens a small panel
 * (Escape and a click outside close it, and focus returns to the line).
 */
export function DreamNavStatus({
  rail,
  onlyRunning = false,
}: {
  rail: boolean;
  /** Shown only while a dream runs (the nav's For you block); its other states are on Home. */
  onlyRunning?: boolean;
}) {
  const { view, project } = useDreamsState();
  const go = useStore((s) => s.go);
  const running = view?.running ?? null;
  useClock(running ? 30_000 : 3_600_000);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const shown = open && running !== null;
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!shown) return;
    panel.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close(true);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [shown]);
  if (!view || (onlyRunning && !running)) return null;
  const now = Date.now();
  const { line, model, tone } = navLine(view, now);
  const full = model ? `${line} · ${model}` : line;
  const repo = running && view.repos.find((r) => r.id === running.repoId);
  return (
    <div className="nav-dream-wrap" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className={`nav-status nav-dream is-${tone}`}
        aria-label={rail ? full : undefined}
        aria-haspopup={running ? 'true' : undefined}
        aria-expanded={running ? shown : undefined}
        title={full}
        onClick={() => {
          if (running) setOpen(!open);
          else go({ kind: 'dreams' });
        }}
      >
        <WeatherMoon12Regular aria-hidden="true" />
        {!rail && <span className="nav-status-text">{full}</span>}
      </button>
      {shown && running && (
        <div
          ref={panel}
          tabIndex={-1}
          className="menu dream-pop"
          aria-label="The dream that is running"
        >
          <div className="dream-pop-head">
            <strong className="grow">{line}</strong>
            <span className="muted small">
              {minutesSince(running.startedAt, now)} min
            </span>
          </div>
          <span className="muted small">
            {stepLine(running.step, repo ? repo.newSessions : null)}
          </span>
          <code className="small">{view.settings.model}</code>
          <UsageBar view={view} />
          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (project) void api().invoke('dream:stop', project);
                close(true);
              }}
            >
              Stop this dream
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                close(false);
                go({ kind: 'dreams' });
              }}
            >
              Open Dreams
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
