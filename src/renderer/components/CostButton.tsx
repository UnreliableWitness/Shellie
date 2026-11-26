import { eur } from '../format';
import { useCaptureOff } from '../hooks/useReceiverStatus';
import { useTaskCost } from '../hooks/useTaskCosts';
import { useStore } from '../store';

const DASH = String.fromCharCode(0x2014);
const WARN = String.fromCharCode(0x26a0);

/** The task's AI cost; opens the Usage tab. Carries a warning mark while AI usage is not captured. */
export function CostButton({ taskId }: { taskId: string }) {
  const openUsage = useStore((s) => s.openUsage);
  const cost = useTaskCost(taskId);
  const off = useCaptureOff();
  const shown = cost === null ? null : eur(cost);
  return (
    <button
      type="button"
      className="btn btn-subtle btn-sm taskbar-cost"
      aria-label={`AI cost ${shown ?? 'unknown'}, open usage${off ? `. ${off}` : ''}`}
      title={off ?? 'AI cost, open usage'}
      onClick={() => openUsage(taskId)}
    >
      {off && (
        <span
          className="taskbar-cost-warn"
          data-part="capture-off"
          aria-hidden="true"
        >
          {WARN}
        </span>
      )}
      <span className="mono">{shown ?? DASH}</span>
    </button>
  );
}
