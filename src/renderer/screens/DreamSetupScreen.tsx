import { useEffect, useId, useRef, useState } from 'react';
import {
  canSwitchOn,
  confirmSentence,
  type DreamingSettings,
  type DreamView,
  widenings,
  widens,
} from '../../shared/dreams';
import { errorMessage } from '../../shared/errors';
import { api } from '../api';
import { IdleStep } from '../components/dreams/IdleStep';
import { LimitStep } from '../components/dreams/LimitStep';
import { RepoRow } from '../components/dreams/RepoRow';
import { ownRepos } from '../components/dreams/dreamWords';
import { useDreamsState } from '../components/dreams/useDreams';
import { DreamsLoading } from '../components/dreams/DreamsLoading';
import { ConfirmBar, PageHeader } from '../components/ui';

const WAITING_FOR: Record<
  NonNullable<ReturnType<typeof canSwitchOn>>,
  string
> = {
  model: 'Choose a model.',
  test: 'Test the model.',
  limit: 'Choose how much it may spend a day.',
  repos: 'Tick a repo that has a folder a dream may change.',
};

const CHANGED_ELSEWHERE =
  'The settings changed elsewhere. Your unconfirmed change was dropped.';
const DROPPED_FOR_MODEL =
  'Your unconfirmed change was dropped: dreaming switched off for the new model.';

/** The repos a dream would read, by name, for the sentence. */
const repoNames = (view: DreamView, s: DreamingSettings): string[] =>
  view.repos
    .filter((r) => s.repos[r.id]?.on && s.repos[r.id].folders.length > 0)
    .map((r) => r.name);

/** "Let Shellie dream": the four steps and the panel that says what is being switched on. */
export function DreamSetupScreen() {
  const { view, failed, retry, project } = useDreamsState();
  if (project === null)
    return (
      <DreamsLoading
        title="Let Shellie dream"
        message="Dreams belong to a project. Add a project first."
        failed
        retry={retry}
      />
    );
  if (view === null)
    return (
      <DreamsLoading
        title="Let Shellie dream"
        message="Dreams could not be loaded"
        failed={failed}
        retry={retry}
      />
    );
  // A new project is a new setup: nothing typed for one carries over to another.
  return <Setup key={project} view={view} project={project} />;
}

/** A model picked but not saved: it is being tested, or the test failed. */
type PendingModel = { model: string; message: string | null };

/**
 * Every control shows `shown`: the saved settings, or the held draft while a widening change waits for its
 * confirmation. Local state is only what is being typed, the tick box and a running test.
 */
function Setup({ view, project }: { view: DreamView; project: string }) {
  const [saved, setSaved] = useState<DreamingSettings>(view.settings);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  // A widening change made while dreaming is on, waiting for the sentence and the tick.
  const [held, setHeld] = useState<DreamingSettings | null>(null);
  const [droppedNote, setDroppedNote] = useState<string | null>(null);

  // Settings that changed under us (not our own save, which `saved` already has) replace the saved ones and
  // drop a held draft that was based on the old state.
  const viewJson = JSON.stringify(view.settings);
  const seen = useRef(viewJson);
  useEffect(() => {
    if (seen.current === viewJson) return;
    seen.current = viewJson;
    if (JSON.stringify(savedRef.current) === viewJson) return;
    setSaved(view.settings);
    setHeld((h) => {
      if (h) setDroppedNote(CHANGED_ELSEWHERE);
      return null;
    });
  }, [viewJson, view.settings]);

  const shown = held ?? saved;
  const on = saved.enabled;

  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingModel | null>(null);
  const [testing, setTesting] = useState(false);
  const [testedNote, setTestedNote] = useState<string | null>(null);
  const [retestFailed, setRetestFailed] = useState<string | null>(null);
  // OpenCode's list for the picker, as other screens read it: undefined while reading, null when it could not be.
  const [listed, setListed] = useState<string[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api()
      .invoke('agents:opencodeModels')
      .then(
        (m) => live && setListed(m),
        () => live && setListed(null),
      );
    return () => {
      live = false;
    };
  }, []);
  const [confirmNoLimit, setConfirmNoLimit] = useState(false);
  const panelHeading = useRef<HTMLHeadingElement>(null);

  const repoName = (id: string) =>
    view.repos.find((r) => r.id === id)?.name ?? id;
  const names = repoNames(view, shown);
  const missing = canSwitchOn(shown);
  const sentence = missing === null ? confirmSentence(shown, names) : null;
  const isHeld = held !== null;
  // The tick is for one sentence in one state and one draft: any other is read again.
  const heldJson = JSON.stringify(held);
  useEffect(() => setTicked(false), [sentence, on, heldJson]);
  useEffect(() => {
    if (isHeld) panelHeading.current?.focus();
  }, [isHeld]);

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
    setDroppedNote(null);
    if (on && widens(saved, next)) {
      setError(null);
      setHeld(next);
      return;
    }
    const result = await run(() =>
      api().invoke('dream:save', project, next, false),
    );
    if (result) {
      setSaved(result);
      setHeld(null);
    }
  };

  const confirmChange = async () => {
    if (!held) return;
    setBusy(true);
    const result = await run(() =>
      api().invoke('dream:save', project, held, true),
    );
    setBusy(false);
    if (result) {
      setSaved(result);
      setHeld(null);
      setTicked(false);
    }
  };

  const switchOn = async () => {
    setBusy(true);
    const result = await run(() =>
      api().invoke('dream:switchOn', project, true),
    );
    setBusy(false);
    if (result) {
      setSaved(result);
      setTicked(false);
    }
  };

  /**
   * Picking a model tests it at once; main saves it as chosen and tested only when the test passes. Testing the
   * saved model again changes nothing, so it does not gate the panel.
   */
  const testModel = async (model: string) => {
    const same = model === saved.model;
    if (!same) setPending({ model, message: null });
    setTesting(true);
    setTestedNote(null);
    setRetestFailed(null);
    setError(null);
    let message: string | null = null;
    try {
      const result = await api().invoke('dream:test', project, model);
      if (result.ok) {
        if (!same) {
          // Main switched dreaming off, and a held draft was based on the old model.
          setHeld((h) => {
            if (h) setDroppedNote(DROPPED_FOR_MODEL);
            return null;
          });
        }
        setSaved((s) => ({
          ...s,
          enabled: s.model === model ? s.enabled : false,
          model,
          testedModel: model,
        }));
        setPending(null);
        setTestedNote(`${model} answered.`);
      } else message = result.message;
    } catch (e) {
      message = errorMessage(e);
    }
    setTesting(false);
    if (message !== null) {
      if (same) setRetestFailed(message);
      else setPending({ model, message });
    }
  };

  const selected = pending?.model ?? saved.model;
  const tested =
    pending === null &&
    saved.model !== null &&
    saved.testedModel === saved.model;
  const models = listed
    ? [...new Set([...(saved.model ? [saved.model] : []), ...listed])]
    : listed;

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
                      value={selected ?? ''}
                      disabled={testing}
                      onChange={(e) => {
                        if (e.target.value) void testModel(e.target.value);
                      }}
                    >
                      {selected === null && (
                        <option value="">Choose a model</option>
                      )}
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : models === undefined ? (
                  <p className="grow muted">
                    Reading OpenCode&rsquo;s models&hellip;
                  </p>
                ) : (
                  <p className="grow text-warn">OpenCode was not found</p>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={!selected || testing}
                  onClick={() => selected && void testModel(selected)}
                >
                  {testing ? 'Testing…' : tested ? 'Test again' : 'Test'}
                </button>
                {pending && saved.model && !testing && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setPending(null)}
                  >
                    Back to {saved.model}
                  </button>
                )}
              </div>
              {pending?.message != null && (
                <p role="alert" className="small text-red">
                  Not tested: {pending.message}
                </p>
              )}
              {retestFailed !== null && (
                <p role="alert" className="small text-red">
                  Not tested: {retestFailed}
                </p>
              )}
              {testedNote && !pending && (
                <p role="status" className="small text-green">
                  {testedNote} Shellie checked that no other model took part. It
                  checks again after every dream, and switches dreaming off if
                  another model ever answers.
                </p>
              )}
              {on && pending && (
                <p role="status" className="small text-warn">
                  Dreaming will switch off until {pending.model} is tested and
                  you confirm again.
                </p>
              )}
            </Step>

            <Step n={2} title="How much it may spend a day" locked={testing}>
              <LimitStep
                limit={shown.limit}
                euroLimitOffered={view.euroLimitOffered}
                model={saved.model}
                onLimit={(limit) => void change({ ...shown, limit })}
                onNoLimit={() => setConfirmNoLimit(true)}
              />
              {confirmNoLimit && (
                <ConfirmBar
                  message={`Dreams may spend without a limit on ${saved.model ?? 'the model'}.`}
                  confirmLabel="Use no limit"
                  onConfirm={() => {
                    setConfirmNoLimit(false);
                    void change({ ...shown, limit: { kind: 'none' } });
                  }}
                  onCancel={() => setConfirmNoLimit(false)}
                />
              )}
            </Step>

            <Step n={3} title="When it dreams" locked={testing}>
              <IdleStep
                minutes={shown.idleMinutes}
                onMinutes={(idleMinutes) =>
                  void change({ ...shown, idleMinutes })
                }
              />
            </Step>

            <Step
              n={4}
              title="Which repos, and what a dream may change"
              locked={testing}
            >
              {ownRepos(view).length === 0 && (
                <p className="muted">
                  No repos in this project yet. Add one, or link one to this
                  project, first.
                </p>
              )}
              {ownRepos(view).map((r) => (
                <RepoRow
                  key={r.id}
                  repo={r}
                  settings={shown}
                  onChange={(rec) =>
                    void change({
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
              {isHeld
                ? 'Confirm the change'
                : on
                  ? 'Dreaming is on'
                  : 'What you are switching on'}
            </h2>
            {droppedNote && <p role="status">{droppedNote}</p>}
            {pending ? (
              <p className="muted">
                Test the model first. Nothing can be switched on or confirmed
                while the model in the list is not the one that was tested.
              </p>
            ) : (
              <>
                {sentence ? (
                  <p className="dream-sentence">{sentence}</p>
                ) : (
                  <p className="muted">
                    Not ready to switch on yet. {WAITING_FOR[missing!]}
                  </p>
                )}
                {held && (
                  <ul className="dream-adds" aria-label="What this change adds">
                    {widenings(saved, held, repoName).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                {(isHeld || !on) && (
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
                    {isHeld ? (
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
  locked = false,
  children,
}: {
  n: number;
  title: string;
  aside?: React.ReactNode;
  /** Read only while something else runs. */
  locked?: boolean;
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
      <fieldset className="dream-fieldset" disabled={locked}>
        {children}
      </fieldset>
    </section>
  );
}
