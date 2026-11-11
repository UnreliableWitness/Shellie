import { entryPath } from '../../../shared/reader';
import { progressLine, type ReadingUpNext } from '../../../shared/reading';
import {
  openPiece,
  useReading,
  useReadingNudges,
} from '../../hooks/useReadingFeed';
import { useStore } from '../../store';
import { track } from '../../telemetry';
import { Band } from '../home/Band';

/** Why a piece is up next, in the words of its row. */
export function whyText({ why, entry }: ReadingUpNext): string {
  if (entry.kind === 'letter') return `a letter: ${entry.about} changed`;
  if (why === 'changed') return 'changed since you read it';
  if (why === 'work') {
    const [first, ...rest] = entry.read.work ?? [];
    if (!first) return 'for your work';
    return `for #${first.id} ${first.title}${rest.length ? ` and ${rest.length} more` : ''}`;
  }
  return entry.read.chapter
    ? `next in the book: ${entry.read.chapter}`
    : 'next in the book';
}

const titleOf = ({ entry }: ReadingUpNext) =>
  entry.kind === 'letter' ? entry.letter.title : entry.read.title;
const minutesOf = ({ entry }: ReadingUpNext) =>
  entry.kind === 'letter' ? entry.letter.minutes : entry.read.minutes;

/**
 * Home › Reading: per brain with something up next, how far the reader is and the handful to read next, each with
 * why it is there. Absent when no brain has anything up next, and when the nudges are off.
 */
export function ReadingBand() {
  const on = useReadingNudges();
  const go = useStore((s) => s.go);
  const brains = useReading().filter((r) => r.next.length > 0);
  if (!on || !brains.length) return null;
  return (
    <Band title="Reading">
      <div className="home-reading">
        {brains.map(({ brain, list, next }) => (
          <div key={brain.brainId} className="home-reading-brain">
            <div className="home-reading-head">
              <button
                type="button"
                className="home-reading-name"
                onClick={() => {
                  track('home.clicked', { band: 'reading' });
                  go({ kind: 'brain', brainId: brain.brainId });
                }}
              >
                {brain.name}
              </button>
              <span className="muted small">{progressLine(list)}</span>
            </div>
            <ul className="home-reading-list">
              {next.map((n) => (
                <li key={entryPath(n.entry)}>
                  <button
                    type="button"
                    className="home-reading-row"
                    onClick={() =>
                      openPiece(
                        brain.brainId,
                        entryPath(n.entry),
                        'home',
                        n.why,
                        n.entry.kind,
                      )
                    }
                  >
                    <span className="home-reading-title">{titleOf(n)}</span>
                    <span className="muted small">
                      {whyText(n)} · {minutesOf(n)} min
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Band>
  );
}
