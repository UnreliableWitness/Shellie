import { useEffect, useRef, useState } from 'react';
import type { DreamView } from '../../shared/dreams';
import { errorMessage } from '../../shared/errors';
import { api } from '../api';
import {
  dreamTaskName,
  journalLine,
  nowLine,
  openedResults,
  openResults,
  ownRepos,
  repoStateLine,
  waitLine,
  whenWords,
} from '../components/dreams/dreamWords';
import { spacedNumber } from '../components/dreams/folders';
import { SwitchedOffNotice } from '../components/dreams/SwitchedOffNotice';
import { UsageBar } from '../components/dreams/UsageBar';
import { useDreamsState } from '../components/dreams/useDreams';
import { DreamsLoading } from '../components/dreams/DreamsLoading';
import { ConfirmBar, PageHeader } from '../components/ui';
import { plural } from '../format';
import { useStore } from '../store';

const NOTE_MS = 10_000;

/** Dreams: what dreaming does, what waits for review, the repos and the journal. */
export function DreamsScreen() {
  const { view, failed, retry, project } = useDreamsState();
  if (project === null)
    return (
      <DreamsLoading
        title="Dreams"
        message="Dreams belong to a project. Add a project first."
        failed
        retry={retry}
      />
    );
  if (view === null)
    return (
      <DreamsLoading
        title="Dreams"
        message="Dreams could not be loaded"
        failed={failed}
        retry={retry}
      />
    );
  return <Dreams view={view} project={project} />;
}

function Dreams({ view, project }: { view: DreamView; project: string }) {
  const go = useStore((s) => s.go);
  const on = view.settings.enabled;
  const [confirmOff, setConfirmOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();
  // A repo removed since: the name stored with the journal line, else none.
  const nameOf = (id: string, stored?: string) =>
    view.repos.find((r) => r.id === id)?.name ?? stored ?? 'a removed repo';
  const waits = openResults(view).length + openedResults(view).length > 0;

  const switchOff = async () => {
    setConfirmOff(false);
    try {
      await api().invoke('dream:switchOff', project);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Dreams"
        after={
          <span className={on ? 'pill-ok' : 'pill-soon'}>
            {on ? 'On' : 'Off'}
          </span>
        }
        commands={
          on && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => go({ kind: 'dream-setup' })}
              >
                Change setup
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmOff(true)}
              >
                Switch off
              </button>
            </>
          )
        }
      />
      {confirmOff && (
        <ConfirmBar
          message="Switch off dreaming? A dream that is running is stopped."
          confirmLabel="Switch off"
          onConfirm={() => void switchOff()}
          onCancel={() => setConfirmOff(false)}
        />
      )}
      <div className="page-body dreams">
        <SwitchedOffNotice view={view} />
        {error && (
          <p role="alert" className="text-red">
            {error}
          </p>
        )}
        {on ? (
          <>
            <Strip view={view} now={now} />
            <Waiting view={view} now={now} />
            <Repos view={view} now={now} />
          </>
        ) : (
          <>
            {/* What waits stays reachable while off: a branch opened as a task, a result. */}
            {waits && <Waiting view={view} now={now} />}
            <section className="card dream-invite" aria-label="Dreaming is off">
              <h2>Let Shellie dream</h2>
              <p className="muted">
                While you are away, Shellie reads what was said in a
                repo&rsquo;s agent sessions and proposes better skills and rules
                for it, on a branch you review. Nothing dreams until you switch
                it on.
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => go({ kind: 'dream-setup' })}
                >
                  Set up dreaming
                </button>
              </div>
            </section>
          </>
        )}
        <section aria-label="Journal" className="dream-section">
          <h2>Journal</h2>
          {view.journal.length === 0 ? (
            <p className="muted">No dreams yet.</p>
          ) : (
            <div className="dream-list dream-journal">
              {view.journal.map((e) => (
                <div
                  key={`${e.repoId}/${e.dreamId}/${e.at}`}
                  className="dream-row"
                >
                  <span className="muted small dream-when">
                    {whenWords(e.at, now)}
                  </span>
                  <strong className="dream-name">
                    {nameOf(e.repoId, e.repoName)}
                  </strong>
                  <span className="grow dream-clamp">{journalLine(e)}</span>
                  <span className="muted mono small">
                    {spacedNumber(e.tokens)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Strip({ view, now }: { view: DreamView; now: number }) {
  const next = !view.running && view.next;
  return (
    <section aria-label="Status" className="dream-strip">
      <div className="dream-cell">
        <span className="muted small">Model</span>
        <span className="mono">{view.settings.model}</span>
        <span className="muted small">
          through OpenCode · every call checked
        </span>
      </div>
      <div className="dream-cell">
        <span className="muted small">Today</span>
        <UsageBar view={view} />
      </div>
      <div className="dream-cell">
        <span className="muted small">Starts</span>
        <span>After {view.settings.idleMinutes} minutes idle</span>
        {/* Both rules are fixed in main (ready.ts), not settings. */}
        <span className="muted small">
          on mains power · never while an agent works
        </span>
      </div>
      <div className="dream-cell">
        <span className="muted small">Now</span>
        <span>{nowLine(view, now)}</span>
        {next && (
          <span className="muted small">
            next:{' '}
            {view.repos.find((r) => r.id === next.repoId)?.name ?? 'a repo'},{' '}
            {plural(next.newSessions, 'new session')}
          </span>
        )}
      </div>
    </section>
  );
}

function Waiting({ view, now }: { view: DreamView; now: number }) {
  const go = useStore((s) => s.go);
  const rows = openResults(view);
  const opened = openedResults(view);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const leave = async (repoId: string) => {
    setLeaving(null);
    setError(null);
    try {
      await api().invoke('dream:leaveBranch', repoId);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const leavingRow = opened.find((r) => r.id === leaving);
  return (
    <section aria-label="Waiting for you" className="dream-section">
      <h2>Waiting for you</h2>
      {leavingRow?.state.opened && (
        <ConfirmBar
          message={`Forget this? The branch ${leavingRow.state.opened.branch} stays in the repo, but Shellie no longer offers to make a task from it.`}
          confirmLabel="Forget it"
          onConfirm={() => void leave(leavingRow.id)}
          onCancel={() => setLeaving(null)}
        />
      )}
      {error && (
        <p role="alert" className="text-red">
          {error}
        </p>
      )}
      {opened.length > 0 && (
        <div className="dream-list">
          {opened.map((r) => {
            const o = r.state.opened;
            if (!o) return null;
            return (
              <div key={`${r.id}/opened/${o.dreamId}`} className="dream-row">
                <span className="grow dream-clamp" id={`dream-name-o-${r.id}`}>
                  {r.name} · {plural(o.kept, 'kept proposal')} on{' '}
                  <span className="mono">{o.branch}</span>, no task yet
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  aria-describedby={`dream-name-o-${r.id}`}
                  onClick={() =>
                    go({
                      kind: 'new-task',
                      repoId: r.id,
                      dream: {
                        id: o.dreamId,
                        branch: o.branch,
                        name: dreamTaskName(
                          o.at,
                          r.id,
                          useStore.getState().tasks,
                        ),
                      },
                    })
                  }
                >
                  Make the task
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-describedby={`dream-name-o-${r.id}`}
                  onClick={() => setLeaving(r.id)}
                >
                  Leave the branch
                </button>
              </div>
            );
          })}
        </div>
      )}
      {rows.length === 0 && opened.length === 0 && (
        <p className="muted">Nothing waits for you.</p>
      )}
      {rows.length > 0 && (
        <div className="dream-list">
          {rows.map((r) => {
            const res = r.state.result;
            if (!res) return null;
            const more = res.proposals.length - 1;
            return (
              <div key={`${r.id}/${res.id}`} className="dream-row">
                <strong className="dream-name" id={`dream-name-w-${r.id}`}>
                  {r.name}
                </strong>
                <span className="grow dream-clamp">
                  {res.proposals[0]?.title ?? 'No proposals'}
                  {more > 0 ? `, and ${more} more` : ''}
                </span>
                <span className="muted small">
                  from {plural(res.sessions, 'session')} ·{' '}
                  {whenWords(res.at, now)}
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  aria-describedby={`dream-name-w-${r.id}`}
                  onClick={() => go({ kind: 'dream', repoId: r.id })}
                >
                  Review
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Repos({ view, now }: { view: DreamView; now: number }) {
  const go = useStore((s) => s.go);
  // Why a Dream now did not start, per repo, for a while.
  const [notes, setNotes] = useState<Record<string, string>>({});
  // One timer per repo: a new answer restarts it; all stop when the screen goes.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all.values()) clearTimeout(t);
      all.clear();
    };
  }, []);
  const note = (repoId: string, text: string) => {
    setNotes((n) => ({ ...n, [repoId]: text }));
    clearTimeout(timers.current.get(repoId));
    timers.current.set(
      repoId,
      setTimeout(() => {
        timers.current.delete(repoId);
        setNotes((n) => {
          const { [repoId]: _gone, ...rest } = n;
          return rest;
        });
      }, NOTE_MS),
    );
  };
  const dreamNow = async (repoId: string) => {
    try {
      const answer = await api().invoke('dream:now', repoId);
      if ('wait' in answer)
        note(repoId, waitLine(answer.wait, view.settings.model));
    } catch (e) {
      note(repoId, errorMessage(e));
    }
  };
  return (
    <section aria-label="Repos" className="dream-section">
      <h2>Repos</h2>
      <div className="dream-list">
        {ownRepos(view).map((r) => {
          const rec = view.settings.repos[r.id];
          const isOn = rec?.on === true;
          return (
            <div key={r.id} className="dream-row">
              <strong className="dream-name" id={`dream-name-r-${r.id}`}>
                {r.name}
              </strong>
              <span className="dream-folders">
                <span className="muted small">
                  {isOn ? 'may change' : 'not dreaming'}
                </span>
                {isOn &&
                  rec.folders.map((f) => (
                    <code key={f} className="dream-folder">
                      {f}
                    </code>
                  ))}
              </span>
              <span className="muted small dream-state">
                {repoStateLine(r, view, now)}
              </span>
              {notes[r.id] && (
                <span role="status" className="small text-warn">
                  {notes[r.id]}
                </span>
              )}
              {isOn ? (
                <button
                  type="button"
                  className="btn"
                  aria-describedby={`dream-name-r-${r.id}`}
                  disabled={r.state.result !== null}
                  onClick={() => void dreamNow(r.id)}
                >
                  Dream now
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  aria-describedby={`dream-name-r-${r.id}`}
                  onClick={() => go({ kind: 'dream-setup' })}
                >
                  Add
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
