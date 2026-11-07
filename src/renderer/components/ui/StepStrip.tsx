const STEPS = [
  { key: 'agents', label: 'Agents' },
  { key: 'connect', label: 'Connect' },
  { key: 'repository', label: 'Repository' },
  { key: 'brain', label: 'Brain' },
] as const;

export type OnboardingStep = (typeof STEPS)[number]['key'];

/** The first-run steps with the finished ones ticked and the current one numbered. */
export function StepStrip({ current }: { current: OnboardingStep }) {
  const at = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="step-strip" aria-label="Setup steps">
      {STEPS.map((s, i) => (
        <li
          key={s.key}
          className={i < at ? 'step done' : i === at ? 'step current' : 'step'}
          aria-current={i === at ? 'step' : undefined}
        >
          <span className="step-dot" aria-hidden="true">
            {i < at ? '✓' : i + 1}
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
