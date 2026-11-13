import { useState, type FormEvent } from 'react';
import {
  CONFLICT_KINDS,
  conflictIdOf,
  picturesReady,
  type BrainView,
  type PictureCounts,
} from '../../../shared/brain';
import { errorMessage } from '../../../shared/errors';
import type { TerminalDef } from '../../../shared/types';
import { api, tryInvoke } from '../../api';
import { dateTime } from '../../format';
import { useStore } from '../../store';
import { openBrainTerminal, trackBrain } from './brainActions';
import { SHARED_WARNING } from './sharing';
import { interpreted, picturesJobComing } from './SourcePictures';

/** Findings listed on the card; the rest is a count (a brain with thousands of broken links must still render). */
const MAX_SHOWN = 50;

const when = (iso: string | null) => (iso ? dateTime(iso) : 'never');

/** `211 of 214 interpreted · 1 not interpreted · 2 never reached the agent`; null when there is nothing to say. */
export function picturesFact(c: PictureCounts): string | null {
  if (c.total === 0 && c.dropped === 0) return null;
  const { done } = interpreted(c);
  return [
    `${done} of ${c.total} interpreted`,
    c.missing > 0 && `${c.missing} not interpreted`,
    c.dropped > 0 && `${c.dropped} never reached the agent`,
    c.accepted > 0 && `${c.accepted} accepted`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Lint findings, what still has to be captured, how the pictures are doing, and the wiki mirror. The day's spend
 * and the cap pause live in What runs by itself.
 */
export function BrainHealth({
  brain,
  onTerminal,
  onOpen,
  onSettle,
}: {
  brain: BrainView;
  onTerminal?: (def: TerminalDef) => void;
  /** Opens a source in Read (a picture finding's Open source). */
  onOpen?: (path: string) => void;
  /** Opens the Settle view at a contradiction or scope change. */
  onSettle?: (conflictId: string) => void;
}) {
  const notify = useStore((s) => s.notify);
  const h = brain.health;
  // Shellie's own checks (links, stale pages, frontmatter, uncaptured) plus what the last lint found.
  const findings = h?.findings ?? [];

  const shown = findings.slice(0, MAX_SHOWN);

  const reevaluate = (source: string) => {
    trackBrain('reevaluate');
    void tryInvoke(
      () => api().invoke('brain:run', brain.id, 'pictures', source),
      notify,
    );
  };
  const resolve = async (f: (typeof findings)[number]) => {
    if (f.kind === 'uncaptured') {
      // A capture job, not a terminal: only Shellie's runner records a capture.
      trackBrain('capture');
      void tryInvoke(
        () => api().invoke('brain:run', brain.id, 'capture', f.page),
        notify,
      );
      return;
    }
    trackBrain('resolve');
    const def = await openBrainTerminal(
      brain.id,
      notify,
      null,
      `resolve: ${f.kind} on ${f.page}: ${f.detail}`,
    );
    if (def) onTerminal?.(def);
  };

  const pictures = h ? picturesFact(h.pictures) : null;
  // Only brain:get carries health; a view from a list has none.
  if (!h)
    return (
      <section className="brain-card" aria-labelledby="brain-health-h">
        <h2 id="brain-health-h">Health</h2>
        <p className="muted small">Loading</p>
      </section>
    );

  return (
    <section className="brain-card" aria-labelledby="brain-health-h">
      <h2 id="brain-health-h">Health</h2>
      {h.stateError && <p className="brain-error small">{h.stateError}</p>}
      {h.queueHeld && (
        <p className="small">
          <span className="tag tag-warn">held</span> {h.queueHeld}: Settings ›
          Project › Brains › Update skills.
        </p>
      )}
      <dl className="facts">
        <dt>Last lint</dt>
        <dd>{when(h.state?.lastLintAt ?? null)}</dd>
        <dt>Wiki</dt>
        <dd>
          {h.pages} {h.pages === 1 ? 'page' : 'pages'}
        </dd>
        <dt>Uncaptured</dt>
        <dd>{h.uncaptured} uncaptured</dd>
        {pictures && (
          <>
            <dt>Pictures</dt>
            <dd>{pictures}</dd>
          </>
        )}
        <dt>Wiki mirror</dt>
        <dd>
          {h.mirrorPages} pages, refreshed {when(brain.lastRefreshAt)}
        </dd>
      </dl>
      {h.outsideEdits.length > 0 && (
        <div className="small">
          <strong>Edited outside the brain</strong>
          <ul>
            {h.outsideEdits.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <h3>
        {findings.length} {findings.length === 1 ? 'finding' : 'findings'}
      </h3>
      {findings.length > 0 && (
        <ul className="list brain-findings">
          {shown.map((f, i) => (
            <li key={`${f.kind}:${f.page}:${i}`} className="list-row">
              <div className="grow">
                <span>
                  <strong>{f.kind}</strong>{' '}
                  <span className="muted">{f.page}</span>
                </span>
                <span className="small">{f.detail}</span>
              </div>
              {f.kind === 'picture' ? (
                <>
                  {f.detail.includes('not interpreted') &&
                    (!picturesReady(brain) ? (
                      <span className="muted small">
                        Update skills to re-evaluate
                      </span>
                    ) : picturesJobComing(brain.jobs, f.page) ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Re-evaluating ${f.page}`}
                        disabled
                      >
                        Re-evaluating…
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Re-evaluate ${f.page}`}
                        onClick={() => reevaluate(f.page)}
                      >
                        Re-evaluate
                      </button>
                    ))}
                  {f.code === 'pictures-dropped' && onOpen && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={`Open source ${f.page}`}
                      onClick={() => {
                        trackBrain('open-page');
                        onOpen(f.page);
                      }}
                    >
                      Open source
                    </button>
                  )}
                </>
              ) : CONFLICT_KINDS.has(f.kind) && onSettle ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={`Settle: ${f.kind} on ${f.page}`}
                  onClick={() => onSettle(conflictIdOf(f))}
                >
                  Settle
                </button>
              ) : f.kind === 'uncaptured' ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={`Capture ${f.page}`}
                  onClick={() => void resolve(f)}
                >
                  Capture
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={`Resolve in terminal: ${f.kind} on ${f.page}`}
                  onClick={() => void resolve(f)}
                >
                  Resolve in terminal
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {findings.length > shown.length && (
        <p className="muted small">
          {findings.length - shown.length} more not shown
        </p>
      )}
      <ScrubForm brainId={brain.id} shared={brain.sharing !== null} />
    </section>
  );
}

/**
 * Redacts a value (a password, a token that slipped into a document) everywhere in the brain's text files. The
 * value goes to main and nowhere else; what comes back is a count.
 */
function ScrubForm({ brainId, shared }: { brainId: string; shared: boolean }) {
  const notify = useStore((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api().invoke('brain:scrub', brainId, value);
      trackBrain('scrub');
      notify(
        'info',
        (r.files === 0
          ? 'No file held that value'
          : `Redacted in ${r.files} ${r.files === 1 ? 'file' : 'files'}; git history still holds the old text`) +
          (r.skipped > 0
            ? ` (${r.skipped} ${r.skipped === 1 ? 'file' : 'files'} over 20 MB not scanned)`
            : ''),
      );
      setValue('');
      setOpen(false);
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="brain-scrub">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Scrub a value…
      </button>
      {open && shared && <p className="small muted">{SHARED_WARNING}</p>}
      {open && (
        <form className="brain-ask" onSubmit={(e) => void submit(e)}>
          <input
            className="field"
            type="password"
            aria-label="Value to redact"
            placeholder="A password or token to replace with [REDACTED] everywhere"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-sm"
            disabled={busy || value.trim().length < 6}
          >
            Redact everywhere
          </button>
        </form>
      )}
    </div>
  );
}
