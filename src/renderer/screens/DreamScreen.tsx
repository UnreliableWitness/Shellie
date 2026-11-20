import { useEffect, useId, useRef, useState } from 'react';
import type {
  DreamFileDiff,
  DreamProposal,
  DreamResult,
} from '../../shared/dreams';
import { errorMessage } from '../../shared/errors';
import { api } from '../api';
import {
  checkLine,
  KIND_LABEL,
  proposalLine,
  shortDate,
  whenWords,
} from '../components/dreams/dreamWords';
import { spacedNumber } from '../components/dreams/folders';
import { lineDiff } from '../components/dreams/lineDiff';
import { useDreamsState } from '../components/dreams/useDreams';
import { DiffView } from '../components/review/DiffView';
import { ConfirmBar, PageHeader } from '../components/ui';
import { plural } from '../format';
import { useStore } from '../store';

const MINUS = String.fromCharCode(0x2212);

/**
 * One repo's dream result, for review (spec section 8): the proposals, each with where it comes from and what it
 * changes; drop some, open the rest as a task or discard the dream. Every count comes from the view main holds.
 */
export function DreamScreen({ repoId }: { repoId: string }) {
  const { view, failed, retry } = useDreamsState();
  const go = useStore((s) => s.go);
  const repo = view?.repos.find((r) => r.id === repoId) ?? null;
  const res = repo?.state.result ?? null;
  // Opened, discarded or never there: nothing to review here.
  const gone = view !== null && res === null;
  useEffect(() => {
    if (gone) go({ kind: 'dreams' });
  }, [gone, go]);
  if (view === null)
    return (
      <div className="page">
        <PageHeader title="Dream" />
        <div className="page-body">
          {failed ? (
            <>
              <p role="alert">The dream could not be loaded</p>
              <div className="actions">
                <button type="button" className="btn" onClick={retry}>
                  Try again
                </button>
              </div>
            </>
          ) : (
            <p className="muted">Loading&hellip;</p>
          )}
        </div>
      </div>
    );
  if (!repo || !res) return null;
  return <Review key={res.id} repoName={repo.name} result={res} />;
}

function Review({
  repoName,
  result,
}: {
  repoName: string;
  result: DreamResult;
}) {
  const go = useStore((s) => s.go);
  const ids = useId();
  const { proposals } = result;
  const [chosenId, setChosenId] = useState(
    () => (proposals.find((p) => !p.dropped) ?? proposals[0])?.id ?? null,
  );
  const chosen =
    proposals.find((p) => p.id === chosenId) ?? proposals[0] ?? null;
  // The call under way: `drop:<id>`, `open` or `discard`.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const kept = proposals.filter((p) => !p.dropped).length;
  const closing = busy === 'open' || busy === 'discard';

  const call = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy((b) => (b === key ? null : b));
    }
  };

  const drop = (p: DreamProposal, dropped: boolean) =>
    call(`drop:${p.id}`, () =>
      api().invoke('dream:drop', result.repoId, p.id, dropped),
    );

  const openAsTask = () =>
    call('open', async () => {
      const { branch } = await api().invoke('dream:openAsTask', result.repoId);
      go({
        kind: 'new-task',
        repoId: result.repoId,
        dream: {
          id: result.id,
          branch,
          name: `Dream ${shortDate(result.at)}`,
        },
      });
    });

  const discard = () => {
    setConfirmDiscard(false);
    return call('discard', async () => {
      await api().invoke('dream:discard', result.repoId);
      go({ kind: 'dreams' });
    });
  };

  const rowId = (p: DreamProposal) => `${ids}-p-${p.id}`;
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const i = proposals.findIndex((p) => p.id === chosen?.id);
    const next =
      proposals[
        Math.min(
          proposals.length - 1,
          Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)),
        )
      ];
    if (!next) return;
    e.preventDefault();
    setChosenId(next.id);
    document.getElementById(rowId(next))?.focus();
  };

  const check = checkLine(result.removedByCheck);
  return (
    <div className="page dream-review">
      <PageHeader
        inline
        title={`What ${repoName}'s sessions taught`}
        commands={
          <>
            <span className="muted small">{`${kept} of ${proposals.length} kept`}</span>
            <button
              type="button"
              className="btn"
              disabled={closing}
              onClick={() => setConfirmDiscard(true)}
            >
              Discard dream
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={kept === 0 || closing}
              onClick={() => void openAsTask()}
            >
              {`Open ${kept} as a task`}
            </button>
          </>
        }
      />
      <div className="dream-review-meta muted small">
        <span>{`Dreamt ${whenWords(result.at, Date.now())} from ${plural(result.sessions, 'session')}`}</span>
        <span className="mono">{result.model}</span>
        <span>{`${spacedNumber(result.tokens)} tokens`}</span>
        <span className="mono">{result.branch}</span>
      </div>
      {confirmDiscard && (
        <ConfirmBar
          message="Discard this dream? Its branch and proposals are removed. The ideas are remembered so they are not proposed again without new evidence."
          confirmLabel="Discard"
          onConfirm={() => void discard()}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
      {error && (
        <p role="alert" className="text-red dream-review-note">
          {error}
        </p>
      )}
      {result.reverted.length > 0 && (
        <p className="text-warn small dream-review-note">
          {`Changes outside the allowed folders were removed: ${result.reverted.join(', ')}`}
        </p>
      )}
      <div className="dream-review-body">
        <nav aria-label="Proposal list" className="dream-review-list">
          <ul
            aria-label="Proposals"
            className="dream-proposals"
            onKeyDown={onListKey}
          >
            {proposals.map((p, i) => (
              <li key={p.id} className="dream-proposal">
                <button
                  type="button"
                  id={rowId(p)}
                  className="dream-proposal-pick"
                  aria-current={p.id === chosen?.id ? 'true' : undefined}
                  onClick={() => setChosenId(p.id)}
                >
                  <span className="mono small muted">{i + 1}</span>
                  <span className="dream-proposal-text">
                    <span
                      id={`${rowId(p)}-title`}
                      className={
                        p.dropped
                          ? 'dream-proposal-dropped'
                          : 'dream-proposal-title'
                      }
                    >
                      {p.title}
                    </span>
                    <span className="muted small">{proposalLine(p)}</span>
                  </span>
                </button>
                {p.dropped && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-describedby={`${rowId(p)}-title`}
                    disabled={busy === `drop:${p.id}` || closing}
                    onClick={() => void drop(p, false)}
                  >
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
          {check && <p className="muted small">{check}</p>}
        </nav>
        {chosen && (
          <Detail
            key={chosen.id}
            result={result}
            proposal={chosen}
            busy={busy === `drop:${chosen.id}` || closing}
            onDrop={(dropped) => void drop(chosen, dropped)}
          />
        )}
      </div>
    </div>
  );
}

function Detail({
  result,
  proposal: p,
  busy,
  onDrop,
}: {
  result: DreamResult;
  proposal: DreamProposal;
  busy: boolean;
  onDrop: (dropped: boolean) => void;
}) {
  const tasks = useStore((s) => s.tasks);
  const openTask = useStore((s) => s.openTask);
  const id = useId();
  return (
    <section aria-labelledby={`${id}-title`} className="dream-detail">
      <div className="dream-detail-head">
        <div className="dream-detail-claim">
          <span className="muted small">{KIND_LABEL[p.kind]}</span>
          <h2 id={`${id}-title`}>{p.title}</h2>
          <p className="dream-detail-why">{p.why}</p>
        </div>
        {p.dropped ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => onDrop(false)}
          >
            Undo
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => onDrop(true)}
          >
            Drop this proposal
          </button>
        )}
      </div>
      {p.evidence.length > 0 && (
        <section aria-labelledby={`${id}-ev`} className="dream-detail-part">
          <h3 id={`${id}-ev`}>Where it comes from</h3>
          <div className="dream-quotes">
            {p.evidence.map((e, i) => (
              <figure key={i} className="dream-quote">
                <blockquote>{`“${e.quote}”`}</blockquote>
                <figcaption className="muted small">
                  <span>You, in</span>
                  {tasks.some((t) => t.id === e.taskId) ? (
                    <button
                      type="button"
                      className="link"
                      onClick={() => openTask(e.taskId)}
                    >
                      {e.label}
                    </button>
                  ) : (
                    <span>{e.label}</span>
                  )}
                  <span>{shortDate(e.date)}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
      <section aria-labelledby={`${id}-ch`} className="dream-detail-part">
        <h3 id={`${id}-ch`}>What it changes</h3>
        <Changes result={result} proposalId={p.id} />
      </section>
    </section>
  );
}

function Changes({
  result,
  proposalId,
}: {
  result: DreamResult;
  proposalId: string;
}) {
  const [files, setFiles] = useState<DreamFileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState<DreamFileDiff | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    api()
      .invoke('dream:diff', result.repoId, proposalId)
      .then(
        (f) => live && setFiles(f),
        (e: unknown) => live && setError(errorMessage(e)),
      );
    return () => {
      live = false;
    };
  }, [result.repoId, proposalId]);
  useEffect(() => {
    if (full) back.current?.focus();
  }, [full]);

  if (error)
    return (
      <p role="alert" className="text-red">
        {error}
      </p>
    );
  if (!files) return <p className="muted">Loading the changes&hellip;</p>;
  if (files.length === 0) return <p className="muted">No files changed.</p>;
  if (full)
    return (
      <div className="dream-file">
        <div className="dream-file-head">
          <span className="mono small dream-file-path">{full.path}</span>
          <button
            ref={back}
            type="button"
            className="btn btn-sm"
            onClick={() => setFull(null)}
          >
            Back to the changes
          </button>
        </div>
        <div className="dream-fulldiff">
          <DiffView
            uriKey={`dream/${result.repoId}/${result.id}/${proposalId}/${full.path}`}
            before={full.before}
            after={full.after}
            // A new file has nothing on the left: inline shows it over the full width.
            sideBySide={full.before !== ''}
            ignoreWhitespace={false}
            hideUnchanged={false}
          />
        </div>
      </div>
    );
  return (
    <div className="dream-files">
      {files.map((f) => (
        <FileChange key={f.path} file={f} onOpen={() => setFull(f)} />
      ))}
    </div>
  );
}

function FileChange({
  file: f,
  onOpen,
}: {
  file: DreamFileDiff;
  onOpen: () => void;
}) {
  const id = useId();
  const text = !f.binary && !f.tooLarge;
  return (
    <div className="dream-file">
      <div className="dream-file-head">
        <span id={id} className="mono small dream-file-path">
          {f.path}
        </span>
        <span className="mono small text-green">{`+${f.added}`}</span>
        <span className="mono small text-red">{`${MINUS}${f.removed}`}</span>
        {text && (
          <button
            type="button"
            className="btn btn-sm"
            aria-describedby={id}
            onClick={onOpen}
          >
            Open in full diff
          </button>
        )}
      </div>
      {f.binary ? (
        <p className="muted small dream-file-note">
          Binary file: no lines to show.
        </p>
      ) : f.tooLarge ? (
        <p className="muted small dream-file-note">Too large to show here.</p>
      ) : (
        <div className="dream-diff">
          {lineDiff(f.before, f.after).map((h, k) => (
            <div key={k} className="dream-hunk">
              {h.lines.map((l, n) => (
                <div
                  key={n}
                  className={
                    l.sign === '+'
                      ? 'dream-line is-add'
                      : l.sign === '-'
                        ? 'dream-line is-del'
                        : 'dream-line'
                  }
                >
                  <span className="dream-line-no">{l.no}</span>
                  <span className="dream-line-sign">{l.sign}</span>
                  <span className="dream-line-text">{l.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
