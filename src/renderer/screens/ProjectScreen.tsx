import { PageHeader } from '../components/ui';
import { statusText } from '../connectionStatus';
import { useHome } from '../hooks/useHome';
import { chipState } from '../homeView';
import { activeConnection, useStore } from '../store';
import { BrainsBand } from './project/BrainsBand';
import { ReposBand } from './project/ReposBand';
import { SprintBand } from './project/SprintBand';

const host = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The active project's overview: its sprint, its brains and the graph of its repositories. */
export function ProjectScreen() {
  const connection = useStore(activeConnection);
  const go = useStore((s) => s.go);
  const { snapshot } = useHome();
  if (!connection)
    return (
      <div className="page project">
        <PageHeader title="Project" />
        <div className="project-empty">
          <p>Add a project in Settings</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => go({ kind: 'settings' })}
          >
            Settings
          </button>
        </div>
      </div>
    );
  const id = connection.id;
  const home = snapshot?.connections.find((c) => c.connectionId === id);
  const health = chipState(home, connection);
  return (
    <div className="page project">
      <PageHeader
        title={connection.project}
        after={
          <span className={`small project-status is-${health}`}>
            {connection.name} · {host(connection.organizationUrl)} ·{' '}
            {statusText(connection).text}
          </span>
        }
        commands={
          <>
            <button
              type="button"
              className="btn"
              onClick={() =>
                go({ kind: 'settings', scope: 'project', connectionId: id })
              }
            >
              Project settings
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => go({ kind: 'new-task', connectionId: id })}
            >
              New task
            </button>
          </>
        }
      />
      <div className="home-bands">
        <div className="home-split">
          <SprintBand connection={connection} home={home} />
          <BrainsBand connection={connection} />
        </div>
        <ReposBand connection={connection} />
      </div>
    </div>
  );
}
