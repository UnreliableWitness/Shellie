import { useCallback, useEffect, useState } from 'react';
import { mergeMarks } from '../../../shared/reader';
import { api } from '../../api';
import { refreshReading } from '../../hooks/useReadingFeed';
import { loadMarks, saveMarks, type ReadMarks } from './longReads';

/**
 * A brain's read marks and the function that sets one. The marks live in localStorage and in main, which exchanges
 * them with the phone for a brain that goes there: every exchange answers with both sides merged, the newer mark of
 * a text winning. Without an answer the marks are what is known here.
 */
export function useReadMarks(
  brainId: string,
): [ReadMarks, (row: { path: string; hash: string }, read: boolean) => void] {
  const [marks, setMarks] = useState<ReadMarks>(() => loadMarks(brainId));
  /** Sends what is known here and takes in the answer, unless the view moved on to another brain. */
  const exchange = useCallback(
    (live: () => boolean = () => true) =>
      api()
        .invoke('reader:marks', brainId, loadMarks(brainId))
        .then((theirs) => {
          // Read again: a mark set while the answer was on its way is in localStorage by now.
          const mine = loadMarks(brainId);
          const merged = mergeMarks(mine, theirs);
          if (merged !== mine) saveMarks(brainId, merged);
          if (live()) setMarks(merged);
        })
        .catch(() => undefined),
    [brainId],
  );
  useEffect(() => {
    let live = true;
    const isLive = () => live;
    setMarks(loadMarks(brainId));
    void exchange(isLive);
    const off = api().on('reader:marksChanged', (e) => {
      if (e.brainId === brainId) void exchange(isLive);
    });
    return () => {
      live = false;
      off();
    };
  }, [brainId, exchange]);
  const onMark = useCallback(
    (row: { path: string; hash: string }, read: boolean) => {
      const next = {
        ...loadMarks(brainId),
        [row.path]: { hash: row.hash, at: new Date().toISOString(), read },
      };
      saveMarks(brainId, next);
      setMarks(next);
      // Main does not announce a mark set here, so the app's reading list is told to look again.
      void exchange().then(refreshReading);
    },
    [brainId, exchange],
  );
  return [marks, onMark];
}
