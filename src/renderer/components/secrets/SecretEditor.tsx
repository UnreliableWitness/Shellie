import { useState } from 'react';
import {
  ENVIRONMENTS,
  type Environment,
  ENVIRONMENT_LABEL,
  type GivenTo,
  type SecretInput,
  type SecretScope,
  type SecretView,
} from '../../../shared/secrets';
import { api } from '../../api';
import { errorMessage } from '../../../shared/errors';
import type { Repo } from '../../../shared/types';
import { GIVEN_LABEL, GIVEN_ORDER } from './SecretRow';

/**
 * Adds or edits one secret in place. An existing secret's value fields start empty and an empty field keeps the
 * stored value; a typed one replaces it. Errors from main are shown as they come.
 */
export function SecretEditor({
  repos,
  initial,
  scope,
  focusEnv,
  onDone,
  onCancel,
}: {
  repos: Repo[];
  initial?: SecretView;
  /** The scope a new secret starts in. */
  scope: SecretScope;
  focusEnv?: Environment;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [chosen, setChosen] = useState<SecretScope>(initial?.scope ?? scope);
  const [given, setGiven] = useState<GivenTo[]>(
    initial?.givenTo ?? ['setup', 'run'],
  );
  const [values, setValues] = useState<Partial<Record<Environment, string>>>(
    {},
  );
  const [removed, setRemoved] = useState<Environment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const input: SecretInput = {
      ...(initial ? { id: initial.id } : {}),
      scope: chosen,
      name: name.trim(),
      givenTo: GIVEN_ORDER.filter((g) => given.includes(g)),
      values: Object.fromEntries<{ value: string } | null>(
        ENVIRONMENTS.flatMap((e): [Environment, { value: string } | null][] =>
          values[e]
            ? [[e, { value: values[e] as string }]]
            : removed.includes(e)
              ? [[e, null]]
              : [],
        ),
      ),
    };
    setBusy(true);
    setError(null);
    try {
      await api().invoke('secrets:save', input);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const scopeValue = chosen === 'all' ? 'all' : chosen.repoId;

  return (
    <form
      className="card secret-editor"
      aria-label={initial ? 'Edit secret' : 'Add secret'}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="secret-editor-grid">
        <label>
          Name
          <input
            className="input"
            value={name}
            autoFocus={!focusEnv}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Scope
          <select
            className="input"
            value={scopeValue}
            onChange={(e) =>
              setChosen(
                e.target.value === 'all' ? 'all' : { repoId: e.target.value },
              )
            }
          >
            <option value="all">All repositories</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="secret-given">
        <legend>Given to</legend>
        {GIVEN_ORDER.map((g) => (
          <label key={g}>
            <input
              type="checkbox"
              checked={given.includes(g)}
              onChange={(e) =>
                setGiven((cur) =>
                  e.target.checked ? [...cur, g] : cur.filter((x) => x !== g),
                )
              }
            />
            {GIVEN_LABEL[g]}
          </label>
        ))}
        <span className="secret-chip struck">Agents</span>
      </fieldset>
      <div className="secret-editor-grid secret-editor-values">
        {ENVIRONMENTS.map((env) => (
          <div key={env} className="secret-env">
            <label>
              {`${ENVIRONMENT_LABEL[env]} value`}
              <input
                className="input"
                type="password"
                value={values[env] ?? ''}
                autoFocus={focusEnv === env}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  removed.includes(env)
                    ? 'will be removed'
                    : initial?.values[env]
                      ? 'unchanged'
                      : ''
                }
                onChange={(e) => {
                  setValues((cur) => ({ ...cur, [env]: e.target.value }));
                  setRemoved((cur) => cur.filter((x) => x !== env));
                }}
              />
            </label>
            {initial?.values[env] && !removed.includes(env) && !values[env] && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={`Remove ${ENVIRONMENT_LABEL[env]} value`}
                onClick={() => setRemoved((cur) => [...cur, env])}
              >
                Remove value
              </button>
            )}
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="secret-error">
          {error}
        </p>
      )}
      <div className="secret-editor-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Save
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
