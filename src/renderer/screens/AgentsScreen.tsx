import { AgentsSection } from '../components/AgentsSection';
import { PageHeader, StepStrip } from '../components/ui';
import { useActiveBrains } from '../hooks/useBrains';
import { nextStep, stepsFrom } from '../onboardingState';
import { useStore } from '../store';
import { track } from '../telemetry';

/** First-run step 1: the Agents section as a page, with the step strip and Back / Continue. */
export function AgentsScreen() {
  const screen = useStore((s) => s.screen);
  const go = useStore((s) => s.go);
  const back = useStore((s) => s.back);
  const brains = useActiveBrains();
  const onboarding = screen.kind === 'agents' && screen.from === 'get-started';

  const goBack = () => {
    if (onboarding) {
      track('onboarding.step', { step: 'agents', outcome: 'back' });
      back();
    } else go({ kind: 'settings', section: 'terminals' });
  };

  const proceed = () => {
    if (!onboarding) return go({ kind: 'settings', section: 'terminals' });
    track('onboarding.step', { step: 'agents', outcome: 'continued' });
    // Agents counts as done even if the section's first save has not landed yet.
    go(nextStep(stepsFrom({ ...useStore.getState(), brains }), 'agents'));
  };

  return (
    <div className="page">
      {onboarding && <StepStrip current="agents" />}
      <PageHeader title="Agents" />
      <div className="page-body add-repo">
        <AgentsSection embedded />
        <div className="add-repo-actions">
          <button type="button" className="btn" onClick={goBack}>
            Back
          </button>
          <span className="grow" />
          <button type="button" className="btn btn-primary" onClick={proceed}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
