import { useEffect, useState } from 'react';
import type { ReceiverStatus } from '../../shared/usage';
import { api } from '../api';

/**
 * The usage receiver's state: read once, then as main reports it (after a port change in Settings),
 * so what hangs on it goes without a restart. Null until the first reading arrives.
 */
export function useReceiverStatus(): ReceiverStatus | null {
  const [status, setStatus] = useState<ReceiverStatus | null>(null);
  useEffect(() => {
    let live = true;
    // A reading asked for before main reported a change must not replace that change.
    let reported = false;
    const off = api().on('usage:receiverStatus', (r) => {
      reported = true;
      setStatus(r);
    });
    void api()
      .invoke('usage:receiverStatus')
      .then((r) => {
        if (live && !reported) setStatus(r);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      off();
    };
  }, []);
  return status;
}

/** What to say while AI usage is not captured; null while the receiver listens or its state is not known. */
export function captureOffSentence(
  status: ReceiverStatus | null,
): string | null {
  if (!status || status.listening) return null;
  return `AI usage capture is off: ${status.error ?? 'the usage receiver is not running'}. Pick another port in Settings > AI cost and invoicing.`;
}

/** The capture-off sentence for the receiver's current state. */
export function useCaptureOff(): string | null {
  return captureOffSentence(useReceiverStatus());
}
