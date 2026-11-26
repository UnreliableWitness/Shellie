import { useCaptureOff } from '../hooks/useReceiverStatus';
import { useStore } from '../store';

const WARN = String.fromCharCode(0x26a0);

/** A warning line while the usage receiver is not listening, with the way to fix it; nothing otherwise. */
export function CaptureOffLine() {
  const sentence = useCaptureOff();
  const go = useStore((s) => s.go);
  if (!sentence) return null;
  return (
    <div className="check check-warn capture-off" role="status">
      <span aria-hidden="true">{WARN}</span>
      <span className="body">{sentence}</span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => go({ kind: 'settings', section: 'cost' })}
      >
        Open settings
      </button>
    </div>
  );
}
