import { PageHeader } from '../components/ui';
import { useStore } from '../store';

/** Placeholder until the Dreams screen is built: the heading and the way to the setup screen. */
export function DreamsScreen() {
  const go = useStore((s) => s.go);
  return (
    <div className="page">
      <PageHeader title="Dreams" />
      <div className="page-body">
        <p>
          <button
            type="button"
            className="link"
            onClick={() => go({ kind: 'dream-setup' })}
          >
            Set up dreaming
          </button>
        </p>
      </div>
    </div>
  );
}
