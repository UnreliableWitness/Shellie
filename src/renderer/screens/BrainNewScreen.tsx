import { useEffect, useState } from 'react';
import type { Brain } from '../../shared/brain';
import { saveSettings, tryInvoke } from '../api';
import { PageHeader, StepStrip } from '../components/ui';
import { useActiveBrainsLoaded } from '../hooks/useBrains';
import { nextStep, stepsFrom } from '../onboardingState';
import { useStore } from '../store';
import { track } from '../telemetry';
import { CreateBrainForm } from './settings/BrainsSection';

/** First-run step 4: the create-brain form as a page, with the step strip and Back / Skip for now. */
export function BrainNewScreen() {
  const go = useStore((s) => s.go);
  const back = useStore((s) => s.back);
  const notify = useStore((s) => s.notify);
  const connections = useStore((s) => s.connections);
  const { brains, loaded } = useActiveBrainsLoaded();
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const connection =
    connections.find((c) => c.id === connectionId) ?? connections[0];

  /** The next unfinished step's page, counting `made` as a brain that exists. */
  const goOn = (made: readonly unknown[] = brains) =>
    go(nextStep(stepsFrom({ ...useStore.getState(), brains: made }), 'brain'));

  // A brain made elsewhere (or before) already finishes this step.
  const hasBrain = loaded && brains.length > 0;
  useEffect(() => {
    if (hasBrain) goOn();
    // goOn reads the store when it runs; only a brain appearing matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasBrain]);

  const goBack = () => {
    track('onboarding.step', { step: 'brain', outcome: 'back' });
    back();
  };

  const skip = async () => {
    const saved = await tryInvoke(
      () =>
        saveSettings((f) => ({
          onboarding: { ...f.onboarding, brain: 'none' },
        })),
      notify,
    );
    if (!saved) return;
    track('onboarding.step', { step: 'brain', outcome: 'skipped' });
    goOn();
  };

  const created = (brain: Brain) => {
    track('onboarding.step', { step: 'brain', outcome: 'continued' });
    goOn([brain]);
  };

  return (
    <div className="page">
      <StepStrip current="brain" />
      <PageHeader title="A brain for your project" />
      <div className="page-body add-repo">
        <p className="muted">
          {
            "Drop documents or point it at the project's wiki; your agent writes them up as pages, and every task of the project can read them."
          }
        </p>
        {connections.length > 1 && connection && (
          <>
            <label htmlFor="brain-new-project" className="muted">
              Project
            </label>
            <select
              id="brain-new-project"
              className="field"
              value={connection.id}
              onChange={(e) => setConnectionId(e.target.value)}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </>
        )}
        {!connection ? (
          <p className="small muted">Needs a connected project.</p>
        ) : loaded && !hasBrain ? (
          <CreateBrainForm
            key={connection.id}
            connection={connection}
            focus={null}
            onCreated={created}
          />
        ) : null}
        <div className="add-repo-actions">
          <button type="button" className="btn" onClick={goBack}>
            Back
          </button>
          <button type="button" className="link" onClick={() => void skip()}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
