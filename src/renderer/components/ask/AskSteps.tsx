import { Checkmark12Regular } from '@fluentui/react-icons';
import type { AskStep } from '../../../shared/askProgress';

/** What the agent of an ask did, a short line per step, oldest first. */
export function AskSteps({
  steps,
  earlier = 0,
}: {
  steps: AskStep[];
  /** How many steps came before the ones kept. */
  earlier?: number;
}) {
  if (steps.length === 0 && earlier === 0) return null;
  return (
    <ul aria-label="What the agent did" className="ask-steps">
      {earlier > 0 && (
        <li className="ask-step is-earlier">{`${earlier} earlier ${earlier === 1 ? 'step' : 'steps'}`}</li>
      )}
      {steps.map((s, i) => (
        <li key={i} className="ask-step">
          <Checkmark12Regular aria-hidden="true" className="ask-step-tick" />
          <span>{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** The steps of a finished ask, behind their count. */
export function AskStepsFold({ steps }: { steps: AskStep[] | undefined }) {
  if (!steps || steps.length === 0) return null;
  return (
    <details className="ask-steps-fold">
      <summary className="muted small">
        {steps.length === 1 ? '1 step' : `${steps.length} steps`}
      </summary>
      <AskSteps steps={steps} />
    </details>
  );
}
