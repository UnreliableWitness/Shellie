const STEPS = [
  { key: 'agents', label: 'Agents' },
  { key: 'connect', label: 'Connect' },
  { key: 'repository', label: 'Repository' },
  { key: 'brain', label: 'Brain' },
] as const;

import type { OnboardingSteps } from '../../onboardingState';

export type OnboardingStep = (typeof STEPS)[number]['key'];

/** The first-run steps with the finished ones ticked and the current one numbered. */
export function StepStrip({
  current,
  steps,
}: {
  current: OnboardingStep;
  /** Which steps are really done; without it the ones before `current` count as done. */
  steps?: OnboardingSteps;
}) {
  const at = STEPS.findIndex((s) => s.key === current);
  const done = (key: OnboardingStep, i: number) =>
    i !== at && (steps ? steps[key] === 'done' : i < at);
  return (
    <ol className="step-strip" aria-label="Setup steps">
      {STEPS.map((s, i) => (
        <li
          key={s.key}
          className={
            i === at ? 'step current' : done(s.key, i) ? 'step done' : 'step'
          }
          aria-current={i === at ? 'step' : undefined}
        >
          <span className="step-dot" aria-hidden="true">
            {done(s.key, i) ? '✓' : i + 1}
          </span>
          {s.label}
          {i < STEPS.length - 1 && (
            <span className="step-sep" aria-hidden="true">
              &rsaquo;
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
