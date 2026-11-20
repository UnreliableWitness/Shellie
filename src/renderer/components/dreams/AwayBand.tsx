import { useState } from 'react';
import type { DreamView } from '../../../shared/dreams';
import { plural } from '../../format';
import { local } from '../../localStorage';
import { useStore } from '../../store';
import { Band } from '../home/Band';
import { openResults, usageText, whenWords } from './dreamWords';
import { SwitchedOffNotice } from './SwitchedOffNotice';
import { useDreams } from './useDreams';

const KEY = 'shellie.dreams.hiddenOnHome';

/**
 * What Not now remembers of a result: its id and when it was dreamt. An id alone comes back: a dream that was stopped
 * or discarded leaves no branch, so a later dream that day may get the same `<date>-<n>`.
 */
const hideKey = (r: { id: string; at: string }) => `${r.id}@${r.at}`;

/** Hidden results (`hideKey`) by repo id. A storage that is missing, full or holds something else counts as empty. */
function readHidden(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(local()?.getItem(KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (e): e is [string, string[]] =>
          Array.isArray(e[1]) && e[1].every((id) => typeof id === 'string'),
      ),
    );
  } catch {
    return {};
  }
}

/** Keeps only the keys of results still open: a closed result is never needed again. */
function writeHidden(hidden: Record<string, string[]>, view: DreamView) {
  const open = new Map(
    openResults(view).map((r) => [
      r.id,
      r.state.result ? hideKey(r.state.result) : undefined,
    ]),
  );
  const pruned = Object.fromEntries(
    Object.entries(hidden)
      .map(([repoId, ids]) => [
        repoId,
        ids.filter((id) => id === open.get(repoId)),
      ])
      .filter(([, ids]) => ids.length > 0),
  );
  try {
    local()?.setItem(KEY, JSON.stringify(pruned));
  } catch {
    // Not kept: the card comes back on the next visit.
  }
  return pruned;
}

/**
 * "While you were away": the dreams that wait for review, one card each. Nothing without an open result (the
 * switched-off notice, when there is one, stands alone). Not now hides a card here only.
 */
export function AwayBand() {
  const view = useDreams();
  const go = useStore((s) => s.go);
  const [hidden, setHidden] = useState(readHidden);
  if (!view) return null;
  const now = Date.now();
  const cards = openResults(view).filter(
    (r) => !r.state.result || !hidden[r.id]?.includes(hideKey(r.state.result)),
  );
  // A dream that found nothing: one quiet line, only inside the band, for the newest journal entry under 24 hours old.
  const latest = view.journal[0];
  const quiet =
    latest?.outcome === 'nothing' &&
    now - Date.parse(latest.at) < 86_400_000 &&
    latest;
  const notNow = (repoId: string, key: string) =>
    setHidden(
      writeHidden(
        { ...hidden, [repoId]: [...(hidden[repoId] ?? []), key] },
        view,
      ),
    );
  return (
    <>
      <SwitchedOffNotice view={view} />
      {cards.length > 0 && (
        <Band
          title="While you were away"
          aside={
            <span className="muted small">
              Dreamt on <code>{view.settings.model}</code> ·{' '}
              {usageText(view).text} today
            </span>
          }
        >
          <div className="dream-cards">
            {cards.map((r) => {
              const res = r.state.result;
              if (!res) return null;
              return (
                <article key={`${r.id}/${res.id}`} className="dream-card">
                  <div className="dream-card-head">
                    <strong>{r.name}</strong>
                    <span className="muted small">
                      {plural(res.proposals.length, 'proposal')} · from{' '}
                      {plural(res.sessions, 'session')} ·{' '}
                      {whenWords(res.at, now)}
                    </span>
                  </div>
                  <ol className="dream-card-list">
                    {res.proposals.map((p, i) => (
                      <li key={p.id}>
                        <span className="muted mono small">{i + 1}</span>
                        <span className="dream-clamp">{p.title}</span>
                      </li>
                    ))}
                  </ol>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => go({ kind: 'dream', repoId: r.id })}
                    >
                      Review
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => notNow(r.id, hideKey(res))}
                    >
                      Not now
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          {quiet && (
            <p className="muted small">
              A dream for{' '}
              {view.repos.find((r) => r.id === quiet.repoId)?.name ?? 'a repo'}{' '}
              found nothing to propose ({whenWords(quiet.at, now)}).{' '}
              <button
                type="button"
                className="link"
                onClick={() => go({ kind: 'dreams' })}
              >
                All dreams
              </button>
            </p>
          )}
        </Band>
      )}
    </>
  );
}
