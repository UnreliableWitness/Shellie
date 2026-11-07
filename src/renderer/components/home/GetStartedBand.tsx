import { useActiveBrainsLoaded } from '../../hooks/useBrains';
import { stepsFrom } from '../../onboardingState';
import { dismissOnboarding, StepCards } from '../../screens/GetStartedScreen';
import { useStore } from '../../store';

/** Home's reminder of the unfinished first-run steps, until all are done or it is dismissed. */
export function GetStartedBand() {
  const settings = useStore((s) => s.settings);
  const connections = useStore((s) => s.connections);
  const repos = useStore((s) => s.repos);
  const { brains, loaded } = useActiveBrainsLoaded();
  const notify = useStore((s) => s.notify);
  // Before the brains are in, the brain step would read as todo and flash the band.
  if (!settings || !loaded || settings.onboarding.dismissedAt !== null)
    return null;
  if (stepsFrom({ settings, connections, repos, brains }).current === null)
    return null;
  return (
    <section aria-label="Get started" className="home-band get-started-band">
      <div className="section-head">
        <h2 className="home-band-title">Get started</h2>
        <button
          type="button"
          className="link"
          onClick={() => void dismissOnboarding(notify)}
        >
          Dismiss
        </button>
      </div>
      <StepCards band />
    </section>
  );
}
