import { useEffect, useState } from 'react';
import {
  ENVIRONMENTS,
  ENVIRONMENT_LABEL,
  isUnchanged,
  type Environment,
  type ImportCandidate,
  type ImportPlan,
  type ImportRequest,
  type ImportRow,
} from '../../shared/secrets';
import { api, tryInvoke } from '../api';
import { plural } from '../format';
import { PageHeader } from '../components/ui';
import { useStore } from '../store';

type Pick = ImportRequest['picks'][number];
const cellKey = (name: string, env: Environment) => `${name}\0${env}`;
const pickable = (row: ImportRow, env: Environment) =>
  row.cells[env].state === 'new' || row.cells[env].state === 'changed';

function Source({ c }: { c: ImportCandidate }) {
  return (
    <span className="secret-source">
      {c.source}
      {c.tracked && <span className="import-tracked">committed in git</span>}
    </span>
  );
}

function Value({ c }: { c: ImportCandidate }) {
  return (
    <div className="import-value">
      <code>{c.mask}</code>
      <Source c={c} />
    </div>
  );
}

/** The import page (mockup 4): what discovery found, a value per environment, nothing plain in the page. */
export function SecretsImportScreen({ repoId }: { repoId: string }) {
  const repo = useStore((s) => s.repos.find((r) => r.id === repoId));
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [lane, setLane] = useState<Record<string, Environment | 'skip'>>({});
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [rewrite, setRewrite] = useState(true);
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void tryInvoke(
      () => api().invoke('secrets:importPlan', repoId),
      notify,
    ).then((p) => {
      if (!live || !p) return;
      setPlan(p);
      setTicked(new Set(p.rows.filter((r) => r.secretLike).map((r) => r.name)));
    });
    return () => {
      live = false;
      // Main holds the found values for the import; the page closing (imported or not) drops them.
      void api()
        .invoke('secrets:forget', repoId)
        .catch(() => undefined);
    };
  }, [repoId, notify]);

  const back = () => go({ kind: 'secrets', repoId });

  const tableRows = (plan?.rows ?? []).filter((r) =>
    ENVIRONMENTS.some((e) => r.cells[e].candidates.length > 0),
  );
  const hidden = tableRows.filter(isUnchanged);
  const shownRows = showUnchanged
    ? tableRows
    : tableRows.filter((r) => !isUnchanged(r));
  const laneItems = (plan?.rows ?? []).flatMap((r) =>
    r.unassigned.map((c) => ({ row: r, c })),
  );

  /** The radio's pick, else the first value that is not the stored one. */
  const chosen = (row: ImportRow, env: Environment): string | undefined => {
    const all = row.cells[env].candidates;
    return (
      choice[cellKey(row.name, env)] ??
      (all.find((c) => !c.matchesStored) ?? all[0])?.key
    );
  };
  const canLink = (row: ImportRow) =>
    row.cells.test.state === 'missing' &&
    !row.cells.test.stored &&
    pickable(row, 'development');

  /** What Import sends: keys only, one per name and environment; an unassigned value dropped on a cell wins. */
  const picks: Pick[] = (() => {
    const out = new Map<string, Pick>();
    for (const row of shownRows) {
      if (!ticked.has(row.name)) continue;
      for (const env of ENVIRONMENTS) {
        const key = pickable(row, env) ? chosen(row, env) : undefined;
        if (key) out.set(cellKey(row.name, env), { name: row.name, env, key });
      }
      const dev = chosen(row, 'development');
      if (linked.has(row.name) && canLink(row) && dev)
        out.set(cellKey(row.name, 'test'), {
          name: row.name,
          env: 'test',
          key: dev,
        });
    }
    for (const { row, c } of laneItems) {
      const env = lane[c.key];
      if (env && env !== 'skip')
        out.set(cellKey(row.name, env), { name: row.name, env, key: c.key });
    }
    return [...out.values()];
  })();

  const envCount = new Set(picks.map((p) => p.env)).size;
  /** Two picked names that differ only in case (main refuses them): shown on the page, never in a notice. */
  const clash = (() => {
    const seen = new Map<string, string>();
    for (const name of new Set(picks.map((p) => p.name))) {
      const other = seen.get(name.toLowerCase());
      if (other !== undefined) return [other, name] as const;
      seen.set(name.toLowerCase(), name);
    }
    return null;
  })();
  const removable = (plan?.sources ?? []).filter((s) => s.removable);

  const submit = async () => {
    setBusy(true);
    const result = await tryInvoke(
      () =>
        api().invoke('secrets:import', {
          repoId,
          picks,
          rewriteWorktreeCopies: rewrite,
          removeFromMainCheckout: removable
            .map((s) => s.path)
            .filter((p) => remove.has(p)),
        }),
      notify,
    );
    setBusy(false);
    if (!result) return;
    notify(
      'info',
      `Imported ${plural(result.values, 'value', 'values')} into Shellie`,
    );
    back();
  };

  const toggle = <T,>(set: Set<T>, v: T, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(v);
    else next.delete(v);
    return next;
  };

  const cell = (row: ImportRow, env: Environment) => {
    const c = row.cells[env];
    if (c.state === 'missing') {
      if (env === 'test' && canLink(row) && ticked.has(row.name)) {
        const on = linked.has(row.name);
        return (
          <button
            type="button"
            className="secret-add"
            aria-pressed={on}
            onClick={() => setLinked(toggle(linked, row.name, !on))}
          >
            {on ? 'same as Development' : 'same as Development?'}
          </button>
        );
      }
      return (
        <span className="import-missing">
          {c.stored ? 'kept' : 'not found'}
        </span>
      );
    }
    if (c.state === 'same')
      return (
        <div className="import-value import-same">
          <code>{c.candidates[0]?.mask}</code>
          <span className="secret-source">stored already</span>
        </div>
      );
    const note = c.state === 'changed' && (
      <span className="import-changed">
        changed · was {c.was ?? 'added by hand'}
      </span>
    );
    if (c.candidates.length === 1)
      return (
        <>
          <Value c={c.candidates[0]!} />
          {note}
        </>
      );
    const picked = chosen(row, env);
    return (
      <fieldset className="import-conflict">
        <legend>{c.candidates.length} values</legend>
        {c.candidates.map((cand) => (
          <label key={cand.key}>
            <input
              type="radio"
              name={cellKey(row.name, env)}
              checked={picked === cand.key}
              onChange={() =>
                setChoice({ ...choice, [cellKey(row.name, env)]: cand.key })
              }
            />
            <code>{cand.mask}</code> <Source c={cand} />
            {cand.matchesStored && (
              <span className="secret-source">stored already</span>
            )}
          </label>
        ))}
        {note}
      </fieldset>
    );
  };

  const title = `Found in ${repo?.name ?? 'this repository'}`;
  if (!plan)
    return (
      <div className="page">
        <PageHeader title={title} />
        <p className="secrets-lede">Looking for values…</p>
      </div>
    );

  const nothingFound = tableRows.length === 0 && laneItems.length === 0;
  return (
    <div className="page">
      <PageHeader title={title} />
      <p className="secrets-lede">
        {nothingFound
          ? 'Shellie found no values in this repository or its .NET user secrets.'
          : `Shellie found values in ${plural(plan.sources.length, 'place', 'places')} in this repository and its .NET user secrets. Pick a value per environment; your files change only if you tick that below.`}
      </p>
      <div className="import">
        {plan.sources.length > 0 && (
          <ul className="import-sources" aria-label="Sources">
            {plan.sources.map((s) => (
              <li key={s.path}>
                {s.path}
                {s.tracked && (
                  <span className="import-tracked">committed in git</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {shownRows.length > 0 && (
          <table className="secrets-table import-table">
            <thead>
              <tr>
                <th aria-label="Import" />
                <th>Name</th>
                {ENVIRONMENTS.map((e) => (
                  <th key={e}>{ENVIRONMENT_LABEL[e]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shownRows.map((row) => {
                const unchanged = isUnchanged(row);
                const conflict = ENVIRONMENTS.some(
                  (e) => pickable(row, e) && row.cells[e].candidates.length > 1,
                );
                return (
                  <tr
                    key={row.name}
                    className={conflict ? 'import-row-conflict' : undefined}
                  >
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Import ${row.name}`}
                        disabled={unchanged}
                        checked={!unchanged && ticked.has(row.name)}
                        onChange={(e) =>
                          setTicked(toggle(ticked, row.name, e.target.checked))
                        }
                      />
                    </td>
                    <td className="secret-name">
                      <code>{row.name}</code>
                      {!row.secretLike && (
                        <span className="secret-source">plain setting</span>
                      )}
                    </td>
                    {ENVIRONMENTS.map((e) => (
                      <td key={e}>{cell(row, e)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {hidden.length > 0 && (
          <button
            type="button"
            className="secret-add"
            onClick={() => setShowUnchanged(!showUnchanged)}
          >
            {showUnchanged
              ? `Hide ${hidden.length} unchanged`
              : `Show ${hidden.length} unchanged`}
          </button>
        )}
        {laneItems.length > 0 && (
          <section className="import-lane" aria-label="Unassigned">
            <span className="import-lane-tag">
              Unassigned · {laneItems.length}
            </span>
            {laneItems.map(({ row, c }) => {
              const at = lane[c.key];
              const taken = ENVIRONMENTS.filter(
                (e) => ticked.has(row.name) && pickable(row, e),
              );
              return (
                <div key={c.key} className="import-lane-card">
                  <span>
                    <code>{row.name}</code> from {c.source}
                    {c.tracked && (
                      <span className="import-tracked">committed in git</span>
                    )}{' '}
                    <code>{c.mask}</code>
                    {at === 'skip'
                      ? ' — skipped.'
                      : at
                        ? ` — goes to ${ENVIRONMENT_LABEL[at]}.`
                        : ' — drop it on an environment, or skip.'}
                  </span>
                  <span className="import-lane-actions">
                    {ENVIRONMENTS.filter((e) => !taken.includes(e)).map((e) => (
                      <button
                        key={e}
                        type="button"
                        className="btn btn-sm"
                        aria-pressed={at === e}
                        onClick={() => {
                          const next = { ...lane };
                          if (at === e) delete next[c.key];
                          else next[c.key] = e;
                          setLane(next);
                        }}
                      >
                        {ENVIRONMENT_LABEL[e]}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-pressed={at === 'skip'}
                      onClick={() => setLane({ ...lane, [c.key]: 'skip' })}
                    >
                      Skip
                    </button>
                  </span>
                </div>
              );
            })}
          </section>
        )}
        {!nothingFound && (
          <div className="import-options">
            <label>
              <input
                type="checkbox"
                checked={rewrite}
                onChange={(e) => setRewrite(e.target.checked)}
              />
              Rewrite the copies in open tasks&apos; worktrees without the
              imported keys
            </label>
            {removable.length > 0 && (
              <fieldset
                aria-label="Remove the imported keys from the main checkout"
                className="import-remove"
              >
                <legend>
                  Remove the imported keys from the main checkout (.env-style
                  files only; never JSON, user secrets or files in git)
                </legend>
                {removable.map((s) => (
                  <label key={s.path}>
                    <input
                      type="checkbox"
                      aria-label={s.path}
                      checked={remove.has(s.path)}
                      onChange={(e) =>
                        setRemove(toggle(remove, s.path, e.target.checked))
                      }
                    />
                    <code>{s.path}</code>
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        )}
        {plan.skipped > 0 && (
          <p className="secret-source">
            {plural(plan.skipped, 'value', 'values')} skipped (names Shellie
            can&apos;t use as environment variables)
          </p>
        )}
        <p className="import-note">
          Agents run tests and the dev server through <code>shellie run</code>;
          plain <code>npm test</code> in an agent tab runs without secrets.
        </p>
        {clash && (
          <p role="alert" className="small text-red import-clash">
            {`${clash[0]} and ${clash[1]} differ only in case; import one of them`}
          </p>
        )}
        <div className="import-footer">
          <button type="button" className="btn" onClick={back}>
            Cancel
          </button>
          <span className="import-summary">
            {picks.length === 0
              ? 'Nothing to import'
              : `${plural(picks.length, 'value', 'values')} in ${plural(envCount, 'environment', 'environments')} · encrypted on this machine · Production values ask before every use`}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={picks.length === 0 || busy || clash !== null}
            onClick={() => void submit()}
          >
            Import {plural(picks.length, 'value', 'values')}
          </button>
        </div>
      </div>
    </div>
  );
}
