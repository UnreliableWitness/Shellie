import { useEffect, useState } from 'react';
import type { DiscoveredBrain } from '../../../shared/brainShare';
import { api } from '../../api';
import { useBrains } from '../../hooks/useBrains';
import { useStore } from '../../store';

/** "Your team has a brain": a shared brain in the project's Azure DevOps that this person has not joined. */
export function JoinCard({
  connectionId,
  project,
}: {
  connectionId: string;
  project: string;
}) {
  const go = useStore((s) => s.go);
  const [found, setFound] = useState<DiscoveredBrain[]>([]);
  const local = useBrains().filter((b) => b.connectionId === connectionId);
  useEffect(() => {
    let live = true;
    api()
      .invoke('brain:discover', connectionId)
      .then(
        (d) => live && setFound(d),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [connectionId]);
  // A project with a brain of its own is not offered another one.
  const offer = local.length === 0 ? found[0] : undefined;
  if (!offer) return null;
  return (
    <div
      className="home-card project-join"
      role="region"
      aria-label="Join a brain"
    >
      <span className="home-card-title">
        Your team has a brain for {project}. Join?
      </span>
      <span className="muted small">{offer.name}</span>
      <span className="project-links">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => go({ kind: 'brain-join', link: offer.joinLink })}
        >
          Join
        </button>
      </span>
    </div>
  );
}
