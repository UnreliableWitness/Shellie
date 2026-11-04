import { useState, type FormEvent } from 'react';
import type { BrainView } from '../../../shared/brain';
import { errorMessage } from '../../../shared/errors';
import type { TerminalDef } from '../../../shared/types';
import { api, tryInvoke } from '../../api';
import { eur } from '../../format';
import { useStore } from '../../store';
import { openBrainTerminal, trackBrain } from './brainActions';

/** Findings listed on the card; the rest is a count (a brain with thousands of broken links must still render). */
const MAX_SHOWN = 50;

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : 'never';

/** Lint findings, what still has to be captured, the wiki mirror, and the day's spend. */
export function BrainHealth({
  brain,
  onTerminal,
}: {
  brain: BrainView;
  onTerminal?: (def: TerminalDef) => void;
}) {
  const notify = useStore((s) => s.notify);
  const h = brain.health;
  // Shellie's own checks (links, stale pages, frontmatter, uncaptured) plus what the last lint found.
  const findings = h?.findings ?? [];

  const shown = findings.slice(0, MAX_SHOWN);

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
  const resume = () => {
    trackBrain('resume');
    void tryInvoke(() => api().invoke('brain:resumeQueue', brain.id), notify);
  };

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
      {h.queuePaused === 'cap' && (
        <div className="brain-pause" role="status">
          <span>Queue paused: the daily token cap was reached.</span>
          <button type="button" className="btn btn-sm" onClick={resume}>
            Resume
          </button>
        </div>
      )}
      {h.stateError && <p className="brain-error small">{h.stateError}</p>}
      <dl className="facts">
        <dt>Last lint</dt>
        <dd>{when(h.state?.lastLintAt ?? null)}</dd>
        <dt>Wiki</dt>
        <dd>
          {h.pages} {h.pages === 1 ? 'page' : 'pages'}
        </dd>
        <dt>Uncaptured</dt>
        <dd>{h.uncaptured} uncaptured</dd>
        <dt>Wiki mirror</dt>
        <dd>
          {h.mirrorPages} pages, refreshed {when(brain.lastRefreshAt)}
        </dd>
        <dt>Today</dt>
        <dd>
          {h.tokensToday.toLocaleString('en-US')} tokens, {eur(h.costEurToday)}
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
              {f.kind === 'uncaptured' ? (
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
      <ScrubForm brainId={brain.id} />
    </section>
  );
}

/**
 * Redacts a value (a password, a token that slipped into a document) everywhere in the brain's text files. The
 * value goes to main and nowhere else; what comes back is a count.
 */
function ScrubForm({ brainId }: { brainId: string }) {
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
