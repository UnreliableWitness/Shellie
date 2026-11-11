import { useCallback, useEffect, useState } from 'react';
import type { ReaderPiece } from '../../../src/shared/reader';
import { failureOf } from './api';
import type { Reader } from './sync';

export type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; piece: ReaderPiece }
  /** It is not kept on the phone and the server could not be asked. */
  | { status: 'unreachable' }
  /** The server has it no more, or it does not open with this phone's key. */
  | { status: 'unreadable' };

/** A piece's text: the kept one, else fetched. `retry` asks again. */
export function usePiece(reader: Reader, id: string | null) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (id === null) return;
    let live = true;
    setLoaded({ status: 'loading' });
    reader.piece(id).then(
      (piece) => {
        if (!live) return;
        setLoaded(
          piece ? { status: 'ready', piece } : { status: 'unreadable' },
        );
      },
      (err: unknown) => {
        if (!live) return;
        const kind = failureOf(err);
        setLoaded({
          status:
            kind === 'offline' || kind === 'later'
              ? 'unreachable'
              : 'unreadable',
        });
      },
    );
    return () => {
      live = false;
    };
  }, [reader, id, tries]);
  const retry = useCallback(() => setTries((n) => n + 1), []);
  return { loaded, retry };
}
