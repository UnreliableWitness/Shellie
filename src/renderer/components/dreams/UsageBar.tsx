import type { DreamView } from '../../../shared/dreams';
import { usageText } from './dreamWords';

/** Today's usage against the limit: the words, and a real progress bar when there is a limit to measure against. */
export function UsageBar({ view }: { view: DreamView }) {
  const { text, percent } = usageText(view);
  return (
    <>
      <span className="dream-usage-text">{text}</span>
      {percent !== null && (
        <div
          className="dream-bar"
          role="progressbar"
          aria-label="Today's usage of the limit"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent} percent of today's limit used`}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
    </>
  );
}
