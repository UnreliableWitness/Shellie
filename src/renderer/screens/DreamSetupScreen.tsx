import { useEffect, useId, useRef, useState } from 'react';
import {
  canSwitchOn,
  confirmSentence,
  type DreamLimit,
  type DreamingSettings,
  type DreamView,
  widens,
} from '../../shared/dreams';
import { errorMessage } from '../../shared/errors';
import { api } from '../api';
import {
  folderProblem,
  parseTokens,
  spacedNumber,
} from '../components/dreams/folders';
import { useDreams } from '../components/dreams/useDreams';
import { ConfirmBar, PageHeader } from '../components/ui';

type LimitKind = DreamLimit['kind'];

const WAITING_FOR: Record<
  NonNullable<ReturnType<typeof canSwitchOn>>,
  string
> = {
  model: 'Choose a model.',
  test: 'Test the model.',
  limit: 'Choose how much it may spend a day.',
  repos: 'Tick a repo that has a folder a dream may change.',
};

/** The repos a dream would read, by name, for the sentence. */
const repoNames = (view: DreamView, s: DreamingSettings): string[] =>
  view.repos
    .filter((r) => s.repos[r.id]?.on && s.repos[r.id].folders.length > 0)
    .map((r) => r.name);

/** "Let Shellie dream": the four steps and the panel that says what is being switched on. */
export function DreamSetupScreen() {
  const view = useDreams();
  if (view === null)
    return (
      <div className="page">
        <PageHeader title="Let Shellie dream" />
        <div className="page-body muted">Loading&hellip;</div>
      </div>
    );
  return <Setup view={view} />;
}

function Setup({ view }: { view: DreamView }) {
  // What is saved, kept as main answered; the view refreshes it when something else changes it.
  const [saved, setSaved] = useState<DreamingSettings>(view.settings);
  const viewJson = JSON.stringify(view.settings);
  const seen = useRef(viewJson);
  useEffect(() => {
    if (seen.current === viewJson) return;
    seen.current = viewJson;
    setSaved(view.settings);
  }, [viewJson, view.settings]);

  // A widening change made while dreaming is on, waiting for the sentence and the tick.
  const [held, setHeld] = useState<DreamingSettings | null>(null);
  const shown = held ?? saved;
  const on = saved.enabled;

  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickedModel, setPickedModel] = useState<string | null>(saved.model);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [limitKind, setLimitKind] = useState<LimitKind | null>(
    saved.limit?.kind ?? null,
  );
  const [confirmNoLimit, setConfirmNoLimit] = useState(false);
  const panelHeading = useRef<HTMLHeadingElement>(null);

  const names = repoNames(view, shown);
  const missing = canSwitchOn(shown);
  const sentence = missing === null ? confirmSentence(shown, names) : null;
  // The tick is for one sentence only: another sentence is read again.
  useEffect(() => setTicked(false), [sentence]);
  useEffect(() => {
    if (held) panelHeading.current?.focus();
  }, [held]);

  const run = async <T,>(call: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    try {
      return await call();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    }
  };

  /** A change: saved at once unless dreaming is on and it widens, then it waits for the owner's tick. */
  const change = async (next: DreamingSettings) => {
    if (on && widens(saved, next)) {
      setError(null);
      setHeld(next);
      return;
    }
    const result = await run(() => api().invoke('dream:save', next, false));
    if (result) {
      setSaved(result);
      setHeld(null);
    }
  };

  const confirmChange = async () => {
    if (!held) return;
    setBusy(true);
    const result = await run(() => api().invoke('dream:save', held, true));
    setBusy(false);
    if (result) {
      setSaved(result);
      setHeld(null);
    }
  };

  const switchOn = async () => {
    setBusy(true);
    const result = await run(() => api().invoke('dream:switchOn', true));
    setBusy(false);
    if (result) setSaved(result);
  };

  const testModel = async () => {
    if (!pickedModel) return;
    setTesting(true);
    setTestNote(null);
    const model = pickedModel;
    const result = await run(() => api().invoke('dream:test', model));
    setTesting(false);
    if (!result) return;
    if (result.ok) {
      setTestNote({ ok: true, text: `${model} answered.` });
      // Main saved the model as chosen and tested, and switched dreaming off when the model changed.
      setSaved((s) => ({
        ...s,
        enabled: s.model === model ? s.enabled : false,
        model,
        testedModel: model,
      }));
    } else setTestNote({ ok: false, text: result.message });
  };

  const tested = pickedModel !== null && saved.testedModel === pickedModel;
  const models = view.models
    ? [...new Set([...(saved.model ? [saved.model] : []), ...view.models])]
    : null;

  return (
    <div className="page">
      <PageHeader title="Let Shellie dream" />
      <div className="page-body dream-setup">
        <p className="muted dream-intro">
          While you are away, Shellie reads what was said in a repo&rsquo;s
          agent sessions and proposes better skills and rules for it, on a
          branch you review. Nothing dreams until you switch it on here.
        </p>
        <div className="dream-setup-grid">
          <div className="dream-steps">
            <Step
              n={1}
              title="The model that dreams"
              aside={tested && 'Tested'}
            >
              <div className="dream-model-row">
                <div className="dream-field">
                  <span className="muted small">Agent</span>
                  <span>OpenCode</span>
                </div>
                {models ? (
                  <div className="dream-field grow">
                    <label htmlFor="dream-model" className="muted small">
                      Model, from OpenCode&rsquo;s own list
                    </label>
                    <select
                      id="dream-model"
                      className="field mono"
                      value={pickedModel ?? ''}
                      onChange={(e) => {
                        setPickedModel(e.target.value || null);
                        setTestNote(null);
                      }}
                    >
                      <option value="">Choose a model</option>
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <p className="grow text-warn">OpenCode was not found</p>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={!pickedModel || testing}
                  onClick={() => void testModel()}
                >
                  {testing ? 'Testing…' : tested ? 'Test again' : 'Test'}
                </button>
              </div>
              {testNote && (
                <p
                  role={testNote.ok ? 'status' : 'alert'}
                  className={`small ${testNote.ok ? 'text-green' : 'text-red'}`}
                >
                  {testNote.text}
                  {testNote.ok &&
                    ' Shellie checked that no other model took part. It checks again after every dream, and switches dreaming off if another model ever answers.'}
                </p>
              )}
              {on && pickedModel !== saved.model && (
                <p role="status" className="small text-warn">
                  Dreaming will switch off until{' '}
                  {pickedModel ?? 'the new model'} is tested and you confirm
                  again.
                </p>
              )}
            </Step>

            <Step n={2} title="How much it may spend a day">
              <LimitStep
                view={view}
                model={saved.model}
                limit={shown.limit}
                kind={limitKind}
                onKind={(k) => {
                  setLimitKind(k);
                  if (k === 'none') setConfirmNoLimit(true);
                }}
                onLimit={(limit) => change({ ...shown, limit })}
              />
              {confirmNoLimit && (
                <ConfirmBar
                  message={`Dreams may spend without a limit on ${saved.model ?? pickedModel ?? 'the model'}.`}
                  confirmLabel="Use no limit"
                  onConfirm={() => {
                    setConfirmNoLimit(false);
                    void change({ ...shown, limit: { kind: 'none' } });
                  }}
                  onCancel={() => {
                    setConfirmNoLimit(false);
                    setLimitKind(shown.limit?.kind ?? null);
                  }}
                />
              )}
            </Step>

            <Step n={3} title="When it dreams">
              <IdleStep
                minutes={shown.idleMinutes}
                onMinutes={(idleMinutes) => change({ ...shown, idleMinutes })}
              />
            </Step>

            <Step n={4} title="Which repos, and what a dream may change">
              {view.repos.length === 0 && (
                <p className="muted">No repos yet. Add one first.</p>
              )}
              {view.repos.map((r) => (
                <RepoRow
                  key={r.id}
                  repo={r}
                  settings={shown}
                  onChange={(rec) =>
                    change({
                      ...shown,
                      repos: { ...shown.repos, [r.id]: rec },
                    })
                  }
                />
              ))}
              <p className="muted small">
                A dream works on its own branch in its own folder. It never
                touches your checkout, never pushes, and anything it changes
                outside these folders is removed.
              </p>
            </Step>
          </div>

          <aside
            className="card dream-panel"
            aria-label="What you are switching on"
          >
            <h2 ref={panelHeading} tabIndex={-1}>
              {held
                ? 'Confirm the change'
                : on
                  ? 'Dreaming is on'
                  : 'What you are switching on'}
            </h2>
            {sentence ? (
              <p className="dream-sentence">{sentence}</p>
            ) : (
              <p className="muted">
                Not ready to switch on yet. {WAITING_FOR[missing!]}
              </p>
            )}
            {(held || !on) && (
              <>
                <label className="dream-tick">
                  <input
                    type="checkbox"
                    checked={ticked}
                    disabled={missing !== null}
                    onChange={(e) => setTicked(e.target.checked)}
                  />
                  <span>I have read this and want dreaming on.</span>
                </label>
                {held ? (
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!ticked || missing !== null || busy}
                      onClick={() => void confirmChange()}
                    >
                      Confirm the change
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => {
                        setHeld(null);
                        setError(null);
                        setLimitKind(saved.limit?.kind ?? null);
                      }}
                    >
                      Undo
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!ticked || missing !== null || busy}
                    onClick={() => void switchOn()}
                  >
                    Switch on dreaming
                  </button>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="small text-red">
                {error}
              </p>
            )}
            <p className="muted small">
              Later, adding a repo, adding a folder or raising the limit shows
              this sentence again. An update of Shellie never switches dreaming
              on.
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  aside,
  children,
}: {
  n: number;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section className="card dream-step" aria-labelledby={id}>
      <div className="dream-step-head">
        <span className="mono muted" aria-hidden="true">
          {n}
        </span>
        <h2 id={id} className="grow">
          {title}
        </h2>
        {aside && <span className="text-green dream-done">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function LimitStep({
  view,
  model,
  limit,
  kind,
  onKind,
  onLimit,
}: {
  view: DreamView;
  model: string | null;
  limit: DreamLimit | null;
  kind: LimitKind | null;
  onKind: (k: LimitKind) => void;
  onLimit: (l: DreamLimit) => void;
}) {
  const [tokens, setTokens] = useState(
    limit?.kind === 'tokens' ? spacedNumber(limit.perDay) : '',
  );
  const [euros, setEuros] = useState(
    limit?.kind === 'eur' ? String(limit.perDay) : '',
  );
  const [problem, setProblem] = useState<string | null>(null);
  const euroName = model ?? 'the model';

  const commitTokens = () => {
    if (tokens.trim() === '') return;
    const n = parseTokens(tokens);
    if (n === null) {
      setProblem('Use digits only, for example 5 000 000.');
      return;
    }
    setProblem(null);
    setTokens(spacedNumber(n));
    if (limit?.kind !== 'tokens' || limit.perDay !== n)
      onLimit({ kind: 'tokens', perDay: n });
  };
  const commitEuros = () => {
    if (euros.trim() === '') return;
    const n = Number(euros.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) {
      setProblem('Use an amount above zero, for example 5.');
      return;
    }
    setProblem(null);
    if (limit?.kind !== 'eur' || limit.perDay !== n)
      onLimit({ kind: 'eur', perDay: n });
  };
  const enter = (commit: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div role="radiogroup" aria-label="Daily limit" className="dream-limits">
      <div className="dream-limit-row">
        <label>
          <input
            type="radio"
            name="dream-limit"
            checked={kind === 'tokens'}
            onChange={() => onKind('tokens')}
          />
          <span className="dream-limit-name">Tokens</span>
        </label>
        <input
          className="field mono dream-number"
          aria-label="Tokens a day"
          inputMode="numeric"
          disabled={kind !== 'tokens'}
          value={tokens}
          onChange={(e) => setTokens(e.target.value)}
          onBlur={commitTokens}
          onKeyDown={enter(commitTokens)}
        />
        <span className="muted small">
          a day &middot; a running dream is stopped when it is reached
        </span>
      </div>
      <div
        className={`dream-limit-row${view.euroLimitOffered ? '' : ' dream-off'}`}
      >
        <label>
          <input
            type="radio"
            name="dream-limit"
            checked={kind === 'eur'}
            disabled={!view.euroLimitOffered}
            onChange={() => onKind('eur')}
          />
          <span className="dream-limit-name">Euros</span>
        </label>
        {view.euroLimitOffered ? (
          <>
            <input
              className="field mono dream-number"
              aria-label="Euros a day"
              inputMode="decimal"
              disabled={kind !== 'eur'}
              value={euros}
              onChange={(e) => setEuros(e.target.value)}
              onBlur={commitEuros}
              onKeyDown={enter(commitEuros)}
            />
            <span className="muted small">a day</span>
          </>
        ) : (
          <span className="muted small">
            Not available: Shellie has no price for {euroName}
          </span>
        )}
      </div>
      <div className="dream-limit-row">
        <label>
          <input
            type="radio"
            name="dream-limit"
            checked={kind === 'none'}
            onChange={() => onKind('none')}
          />
          <span className="dream-limit-name">No limit</span>
        </label>
        <span className="muted small">
          For a licence without a ceiling. Shellie asks you to confirm this
          separately.
        </span>
      </div>
      {problem && (
        <p role="alert" className="small text-red">
          {problem}
        </p>
      )}
    </div>
  );
}

function IdleStep({
  minutes,
  onMinutes,
}: {
  minutes: number;
  onMinutes: (m: number) => void;
}) {
  const [text, setText] = useState(String(minutes));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setText(String(minutes)), [minutes]);
  const commit = () => {
    const n = Number(text);
    if (!/^\d+$/.test(text.trim()) || n < 1 || n > 120) {
      setProblem('Use a whole number of minutes from 1 to 120.');
      return;
    }
    setProblem(null);
    if (n !== minutes) onMinutes(n);
  };
  return (
    <>
      <div className="dream-idle">
        <label htmlFor="dream-idle">After</label>
        <input
          id="dream-idle"
          className="field dream-minutes"
          aria-label="Minutes idle"
          inputMode="numeric"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
        <span>minutes without keyboard or mouse, by day or by night</span>
      </div>
      {problem && (
        <p role="alert" className="small text-red">
          {problem}
        </p>
      )}
      <p className="muted small">
        Only on mains power, one dream at a time, and never while one of your
        task agents is working. A dream that is running when you come back
        finishes on its own.
      </p>
    </>
  );
}

function RepoRow({
  repo,
  settings,
  onChange,
}: {
  repo: DreamView['repos'][number];
  settings: DreamingSettings;
  onChange: (rec: { on: boolean; folders: string[] }) => void;
}) {
  const rec = settings.repos[repo.id];
  const found = !rec && repo.suggestedFolders.length > 0;
  const folders = rec ? rec.folders : repo.suggestedFolders;
  const on = rec?.on ?? false;
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const add = () => {
    const value = text.trim();
    const why = folderProblem(value);
    if (why) {
      setProblem(why);
      return;
    }
    if (!folders.includes(value))
      onChange({ on, folders: [...folders, value] });
    setText('');
    setProblem(null);
    setAdding(false);
  };

  return (
    <div className="dream-repo">
      <label className="dream-repo-name">
        <input
          type="checkbox"
          checked={on}
          disabled={folders.length === 0}
          onChange={(e) => onChange({ on: e.target.checked, folders })}
        />
        <span>{repo.name}</span>
      </label>
      <ul className="dream-chips" aria-label={`Folders for ${repo.name}`}>
        {folders.map((f) => (
          <li key={f} className="chip-code">
            <span>{f}</span>{' '}
            <button
              type="button"
              className="link"
              aria-label={`Remove ${f} from ${repo.name}`}
              onClick={() =>
                onChange({ on, folders: folders.filter((x) => x !== f) })
              }
            >
              &times;
            </button>
          </li>
        ))}
      </ul>
      {found && <span className="muted small">found in the repo</span>}
      {folders.length === 0 && (
        <span className="muted small">
          No agent packages found. Choose a folder before it can dream.
        </span>
      )}
      {!adding && (
        <button
          type="button"
          className="btn btn-sm"
          aria-label={`${folders.length === 0 ? 'Choose folder' : 'Add folder'} for ${repo.name}`}
          onClick={() => setAdding(true)}
        >
          {folders.length === 0 ? 'Choose folder' : 'Add folder'}
        </button>
      )}
      {adding && (
        <form
          className="dream-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            aria-label={`Folder for ${repo.name}`}
            className="field mono"
            placeholder=".apm or AGENTS.md"
            value={text}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="btn btn-sm">
            Add
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setAdding(false);
              setProblem(null);
              setText('');
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {problem && (
        <p role="alert" className="small text-red dream-repo-problem">
          {problem}
        </p>
      )}
    </div>
  );
}
