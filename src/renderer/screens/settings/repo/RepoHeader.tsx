import type { Repo } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import { useStore } from '../../../store';
import type { RepoSettings } from './useRepoSettings';

/** Name, path, whether the repo has a `.shellie.yml`, the file and folder links and a broken file's error. */
export function RepoHeader({
  repo,
  settings,
}: {
  repo: Repo;
  settings: RepoSettings;
}) {
  const notify = useStore((s) => s.notify);
  const { config, fileError } = settings;
  // A broken file is still a file: it can be opened, not created.
  const hasFile = config
    ? config.found || fileError !== null
    : repo.configFound;
  const run = (fn: () => Promise<unknown>) => void tryInvoke(fn, notify);
  return (
    <div className="settings-repo-header">
      <div className="settings-repo-head">
        <span style={{ fontWeight: 600 }}>{repo.name}</span>{' '}
        <span className="mono small muted">{repo.path}</span>{' '}
        {hasFile ? (
          <span className="tag tag-green">.shellie.yml found</span>
        ) : (
          <span className="tag tag-warn">No .shellie.yml, using defaults</span>
        )}
      </div>
      <div className="settings-repo-head small">
        {hasFile ? (
          <button
            type="button"
            className="link"
            onClick={() =>
              run(() => api().invoke('repos:openConfigFile', repo.id))
            }
          >
            Open .shellie.yml
          </button>
        ) : (
          <button
            type="button"
            className="link"
            onClick={() =>
              run(async () => {
                await api().invoke('repos:createConfigFile', repo.id);
                await settings.reload();
              })
            }
          >
            Create .shellie.yml
          </button>
        )}
        <button
          type="button"
          className="link"
          onClick={() => run(() => api().invoke('repos:reveal', repo.id, null))}
        >
          Reveal folder
        </button>
      </div>
      {fileError !== null && (
        <div role="alert" className="settings-file-error">
          .shellie.yml could not be read: {fileError}. Settings below show the
          defaults with your changes; starting a task fails until the file is
          fixed.
        </div>
      )}
    </div>
  );
}
