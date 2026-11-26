import { ChevronLeft16Regular } from '@fluentui/react-icons';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  DreamDiffLine,
  DreamEvidence,
  DreamFileDiff,
  DreamFileTexts,
  DreamProposal,
  DreamResult,
} from '../../shared/dreams';
import { errorMessage } from '../../shared/errors';
import { LEAK_IN_BRANCH, LEAK_UNCHECKED } from '../../shared/secrets';

const ELLIPSIS = String.fromCharCode(0x2026);
import { api } from '../api';
import {
  checkLine,
  dreamTaskName,
  KIND_LABEL,
  proposalLine,
  shortDate,
  whenWords,
} from '../components/dreams/dreamWords';
import { spacedNumber } from '../components/dreams/folders';
import { useDreamsState } from '../components/dreams/useDreams';
import {
  AskBox,
  adjustingSentence,
  NO_DRAFT,
  type AskDraft,
} from '../components/dreams/AskBox';
import { DreamsLoading } from '../components/dreams/DreamsLoading';
import { DiffView } from '../components/review/DiffView';
import { ConfirmBar, PageHeader } from '../components/ui';
import { useContributeCommands } from '../commands/registry';
import type { Command } from '../commands/types';
import { plural } from '../format';
import { useStore } from '../store';

const MINUS = String.fromCharCode(0x2212);

/** A quote's caption, by who Shellie found said it in the task's turns; a quote found nowhere says only where from. */
const WHO_CAPTION: Record<DreamEvidence['who'], string> = {
  you: 'You, in',
  agent: 'The agent, in',
  unknown: 'From',
};

/**
 * One repo's dream result, for review (spec section 8): the proposals, each with where it comes from and what it
 * changes; drop some, ask for a change to one, send the rest as a pull request or discard the dream. Every count comes from the view main holds.
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
      <DreamsLoading
        title="Dream"
        message="The dream could not be loaded"
        failed={failed}
        retry={retry}
      />
    );
  if (!repo || !res) return null;
  return <Review key={res.id} repoName={repo.name} result={res} />;
}

type DiffState = { files: DreamFileDiff[] } | { error: string };

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
  // The call under way: `open` or `discard`.
  const [busy, setBusy] = useState<string | null>(null);
  // A Drop or Undo asked for: its buttons stay off until the view main sends shows it (or the call fails).
  const [pendingDrop, setPendingDrop] = useState<{
    id: string;
    dropped: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // What main refused the push for (a stored secret in the branch, or a branch it could not check), until answered.
  const [leak, setLeak] = useState<string | null>(null);
  // Whether Shellie can make a pull request for this repo; null until known.
  const [target, setTarget] = useState<{
    available: boolean;
    reason: string | null;
  } | null>(null);
  useEffect(() => {
    let live = true;
    void api()
      .invoke('dream:prTarget', result.repoId)
      .then(
        (t) => t,
        // Not known here: main decides when the button is pressed, and the notice says what it did.
        () => ({ available: true, reason: null }),
      )
      .then((t) => {
        if (live) setTarget(t);
      });
    return () => {
      live = false;
    };
  }, [result.repoId]);
  const kept = proposals.filter((p) => !p.dropped).length;
  // The secret prompt is about the proposals as they were checked: a Drop or Undo since asks the check again.
  const keptIds = proposals
    .filter((p) => !p.dropped)
    .map((p) => p.id)
    .join(' ');
  useEffect(() => setLeak(null), [keptIds]);
  const closing = busy === 'open' || busy === 'discard' || busy === 'pr';
  useEffect(() => {
    if (
      pendingDrop &&
      proposals.find((p) => p.id === pendingDrop.id)?.dropped ===
        pendingDrop.dropped
    )
      setPendingDrop(null);
  }, [pendingDrop, proposals]);

  // Each proposal's changes, fetched once per commit and kept: a Drop, an Undo or a call under way re-renders none
  // of them, and an ask that changed the proposal (a new commit) fetches them again.
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const asked = useRef(new Set<string>());
  // The key each proposal's changes are wanted under now: an answer for an older commit is kept, not shown.
  const wanted = useRef(new Map<string, string>());
  const chosenPid = chosen?.id ?? null;
  const diffKey = chosen
    ? `${result.repoId}/${result.id}/${chosen.id}/${chosen.commit}`
    : null;
  useEffect(() => {
    if (!chosenPid || !diffKey) return;
    wanted.current.set(chosenPid, diffKey);
    if (asked.current.has(diffKey)) {
      // Fetched before (an Undo went back to this commit): it is the one to show again.
      setDiffs((d) =>
        d[diffKey] && d[`shown/${chosenPid}`] !== d[diffKey]
          ? { ...d, [`shown/${chosenPid}`]: d[diffKey] }
          : d,
      );
      return;
    }
    asked.current.add(diffKey);
    // Kept by its key whenever it comes, also once another proposal is chosen.
    void api()
      .invoke('dream:diff', result.repoId, chosenPid)
      .then(
        (files): DiffState => ({ files }),
        (e: unknown): DiffState => ({ error: errorMessage(e) }),
      )
      .then((state) =>
        setDiffs((d) => ({
          ...d,
          [diffKey]: state,
          // Until the new commit's changes are here the last ones stay on screen: nothing blinks.
          ...(wanted.current.get(chosenPid) === diffKey
            ? { [`shown/${chosenPid}`]: state }
            : {}),
        })),
      );
  }, [chosenPid, diffKey, result.repoId]);

  // What is being written in each proposal's box, kept while another proposal is read.
  const [drafts, setDrafts] = useState<Record<string, AskDraft>>({});
  const setDraft = useCallback(
    (update: (d: AskDraft) => AskDraft) => {
      if (chosenPid === null) return;
      setDrafts((ds) => ({
        ...ds,
        [chosenPid]: update(ds[chosenPid] ?? NO_DRAFT),
      }));
    },
    [chosenPid],
  );
  // The ask being worked on (one per result): what it changes must not change under it.
  const adjusting = adjustingSentence(result);

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

  const drop = async (p: DreamProposal, dropped: boolean) => {
    setPendingDrop({ id: p.id, dropped });
    setError(null);
    try {
      await api().invoke('dream:drop', result.repoId, p.id, dropped);
    } catch (e) {
      setPendingDrop(null);
      setError(errorMessage(e));
    }
  };
  const dropping = (p: DreamProposal) =>
    closing || adjusting !== null || pendingDrop?.id === p.id;

  const openAsTask = () =>
    call('open', async () => {
      const { branch } = await api().invoke('dream:openAsTask', result.repoId);
      go({
        kind: 'new-task',
        repoId: result.repoId,
        dream: {
          id: result.id,
          branch,
          name: dreamTaskName(
            result.at,
            result.repoId,
            useStore.getState().tasks,
          ),
        },
      });
    });

  // The old way to change a proposal, kept in the palette: a task on the dream's branch.
  const openNow = useRef(openAsTask);
  useEffect(() => {
    openNow.current = openAsTask;
  });
  const canOpen = kept > 0 && !closing && adjusting === null;
  const commands = useMemo<Command[]>(
    () =>
      canOpen
        ? [
            {
              id: 'dream.openAsTask',
              title: 'Open this dream as a task',
              group: 'tasks',
              run: () => void openNow.current(),
            },
          ]
        : [],
    [canOpen],
  );
  useContributeCommands('dream', commands);

  /** Create pull request (or Push branch): the dream closes when it worked; a secret finding asks first. */
  const send = (pushAnyway: boolean) => {
    setLeak(null);
    setBusy('pr');
    setError(null);
    return api()
      .invoke('dream:pr', result.repoId, pushAnyway)
      .then(
        (sent) => {
          useStore
            .getState()
            .notify(
              'info',
              sent.kind === 'pr'
                ? `Pull request !${sent.id} created from the dream`
                : `Branch ${sent.branch} pushed`,
            );
          go({ kind: 'dreams' });
        },
        (e: unknown) => {
          const message = errorMessage(e);
          if (message.includes(LEAK_IN_BRANCH))
            setLeak(`${LEAK_IN_BRANCH}. Push anyway?`);
          else if (message.includes(LEAK_UNCHECKED))
            setLeak(`${LEAK_UNCHECKED}. Push anyway?`);
          else setError(message);
        },
      )
      .finally(() => setBusy((b) => (b === 'pr' ? null : b)));
  };

  const discard = () => {
    setConfirmDiscard(false);
    return call('discard', async () => {
      await api().invoke('dream:discard', result.repoId);
      go({ kind: 'dreams' });
    });
  };

  const rowId = (p: DreamProposal) => `${ids}-p-${p.id}`;
  /** Up and Down on a proposal's own button move between proposals. */
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!(e.target as HTMLElement).classList.contains('dream-proposal-pick'))
      return;
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
        title={`What ${repoName}’s sessions taught`}
        before={
          <button
            type="button"
            className="btn btn-subtle btn-sm"
            onClick={() => useStore.getState().go({ kind: 'dreams' })}
          >
            <ChevronLeft16Regular aria-hidden="true" /> Dreams
          </button>
        }
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
              disabled={
                kept === 0 || closing || target === null || adjusting !== null
              }
              title={adjusting ?? undefined}
              onClick={() => void send(false)}
            >
              {busy === 'pr'
                ? `Sending${ELLIPSIS}`
                : target && !target.available
                  ? 'Push branch'
                  : 'Create pull request'}
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
      <p className="dream-review-note">
        Shellie proposes these changes to this repo&rsquo;s skills and rules,
        from your past sessions. Drop what you don&rsquo;t want, ask for a
        change where one is nearly right, then{' '}
        {target && !target.available
          ? 'push the branch'
          : 'create a pull request'}
        .
      </p>
      {target && !target.available && (
        <p className="muted small dream-review-note">
          {`Shellie cannot make a pull request here: ${target.reason ?? 'unknown reason'}. It pushes the branch instead.`}
        </p>
      )}
      {leak && (
        <ConfirmBar
          message={leak}
          confirmLabel="Push anyway"
          onConfirm={() => void send(true)}
          onCancel={() => setLeak(null)}
        />
      )}
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
                  {result.adjusting?.proposalId === p.id && (
                    <span
                      className="dot dream-proposal-dot"
                      role="img"
                      aria-label="A change is being made"
                    />
                  )}
                </button>
                {p.dropped && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-describedby={`${rowId(p)}-title`}
                    disabled={dropping(p)}
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
            diff={
              diffKey
                ? (diffs[diffKey] ?? diffs[`shown/${chosen.id}`] ?? null)
                : null
            }
            busy={dropping(chosen)}
            onDrop={(dropped) => void drop(chosen, dropped)}
            draft={drafts[chosen.id] ?? NO_DRAFT}
            onDraft={setDraft}
          />
        )}
      </div>
    </div>
  );
}

function Detail({
  result,
  proposal: p,
  diff,
  busy,
  onDrop,
  draft,
  onDraft,
}: {
  result: DreamResult;
  proposal: DreamProposal;
  diff: DiffState | null;
  busy: boolean;
  onDrop: (dropped: boolean) => void;
  draft: AskDraft;
  onDraft: (update: (d: AskDraft) => AskDraft) => void;
}) {
  const tasks = useStore((s) => s.tasks);
  const openTask = useStore((s) => s.openTask);
  const id = useId();
  const pane = useRef<HTMLElement>(null);
  return (
    <section
      ref={pane}
      aria-labelledby={`${id}-title`}
      className="dream-detail"
    >
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
            {[
              ...p.evidence.filter((e) => e.who !== 'unknown'),
              ...p.evidence.filter((e) => e.who === 'unknown'),
            ].map((e, i) => (
              <figure key={i} className="dream-quote">
                <blockquote>{`“${e.quote}”`}</blockquote>
                <figcaption className="muted small">
                  <span>{WHO_CAPTION[e.who]}</span>
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
        <Changes
          repoId={result.repoId}
          dreamId={result.id}
          proposalId={p.id}
          commit={p.commit}
          diff={diff}
        />
      </section>
      <AskBox
        result={result}
        proposal={p}
        draft={draft}
        onDraft={onDraft}
        scope={pane}
      />
    </section>
  );
}

/** A proposal's files as git gave them; memoised, so a re-render of the screen leaves the lines alone. */
const Changes = memo(function Changes({
  repoId,
  dreamId,
  proposalId,
  commit,
  diff,
}: {
  repoId: string;
  dreamId: string;
  proposalId: string;
  /** The proposal's commit: a file open in the full diff is read again when an ask changed it. */
  commit: string;
  diff: DiffState | null;
}) {
  const [full, setFull] = useState<{
    path: string;
    texts: DreamFileTexts | null;
    error: string | null;
  } | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const fullPath = full?.path ?? null;
  useEffect(() => {
    if (fullPath === null) return;
    back.current?.focus();
    let live = true;
    api()
      .invoke('dream:file', repoId, proposalId, fullPath)
      .then(
        (texts) => live && setFull({ path: fullPath, texts, error: null }),
        (e: unknown) =>
          live &&
          setFull({ path: fullPath, texts: null, error: errorMessage(e) }),
      );
    return () => {
      live = false;
    };
  }, [fullPath, repoId, proposalId, commit]);
  const open = useCallback(
    (path: string) => setFull({ path, texts: null, error: null }),
    [],
  );

  if (!diff) return <p className="muted">Loading the changes&hellip;</p>;
  if ('error' in diff)
    return (
      <p role="alert" className="text-red">
        {diff.error}
      </p>
    );
  if (diff.files.length === 0)
    return <p className="muted">No files changed.</p>;
  if (full) {
    const t = full.texts;
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
        {full.error ? (
          <p role="alert" className="text-red dream-file-note">
            {full.error}
          </p>
        ) : !t ? (
          <p className="muted small dream-file-note">Loading&hellip;</p>
        ) : 'binary' in t ? (
          <p className="muted small dream-file-note">
            Binary file: no lines to show.
          </p>
        ) : 'tooLarge' in t ? (
          <p className="muted small dream-file-note">Too large to show here.</p>
        ) : (
          <div className="dream-fulldiff">
            <DiffView
              uriKey={`dream/${repoId}/${dreamId}/${proposalId}/${commit}/${full.path}`}
              before={t.before}
              after={t.after}
              // A new file has nothing on the left: inline shows it over the full width.
              sideBySide={t.before !== ''}
              ignoreWhitespace={false}
              hideUnchanged={false}
            />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="dream-files">
      {diff.files.map((f) => (
        <FileChange key={f.path} file={f} onOpen={open} />
      ))}
    </div>
  );
});

const SIGN: Record<DreamDiffLine['kind'], string> = {
  context: ' ',
  add: '+',
  del: '-',
  note: '',
};

/** One file: its path, git's counts and git's lines, as main sent them. */
const FileChange = memo(function FileChange({
  file: f,
  onOpen,
}: {
  file: DreamFileDiff;
  onOpen: (path: string) => void;
}) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="dream-file">
      <div className="dream-file-head">
        <span id={id} className="mono small dream-file-path">
          {f.path}
        </span>
        <span className="mono small text-green">{`+${f.added}`}</span>
        <span className="mono small text-red">{`${MINUS}${f.removed}`}</span>
        {!f.binary && (
          <button
            type="button"
            className="btn btn-sm"
            aria-describedby={id}
            onClick={() => onOpen(f.path)}
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
          {f.hunks.map((h, k) => (
            <div key={k} className="dream-hunk">
              <div className="dream-line is-head">{h.header}</div>
              {h.lines.map((l, n) => (
                <div key={n} className={`dream-line is-${l.kind}`}>
                  <span className="dream-line-no">
                    {l.newNo ?? l.oldNo ?? ''}
                  </span>
                  <span className="dream-line-sign">{SIGN[l.kind]}</span>
                  <span className="dream-line-text">{l.text}</span>
                </div>
              ))}
            </div>
          ))}
          {f.truncated && (
            <p className="muted small dream-file-note">
              Showing the first 400 lines of this change. Open in full diff for
              the rest.
            </p>
          )}
        </div>
      )}
    </div>
  );
});
