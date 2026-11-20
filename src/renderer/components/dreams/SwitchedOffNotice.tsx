import type { DreamView } from '../../../shared/dreams';
import { useStore } from '../../store';

/** Why dreaming switched itself off, until it is set up and switched on again. Nothing when it did not. */
export function SwitchedOffNotice({ view }: { view: DreamView }) {
  const go = useStore((s) => s.go);
  const off = view.switchedOff;
  if (!off || view.settings.enabled) return null;
  const repo = view.repos.find((r) => r.id === off.repoId)?.name;
  return (
    <div role="alert" className="dream-notice">
      <strong>Dreaming switched itself off</strong>
      <span>
        A call in a dream{repo ? ` for ${repo}` : ''} was answered by{' '}
        <code>{off.answered}</code> instead of <code>{off.chosen}</code>. The
        dream was thrown away and nothing was changed.
      </span>
      <div>
        <button
          type="button"
          className="btn"
          onClick={() => go({ kind: 'dream-setup' })}
        >
          Test the model again
        </button>
      </div>
    </div>
  );
}
