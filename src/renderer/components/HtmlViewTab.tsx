import { ArrowClockwise16Regular, Open16Regular } from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import { docsTarget } from '../../shared/workspaces';
import { api, tryInvoke } from '../api';
import { errorMessage } from '../../shared/errors';
import { type HtmlView, useStore } from '../store';

type Loaded = { url: string; name: string } | { error: string } | null;

/**
 * An HTML file in a tab of the task (#80): served on `shellie-view:` into a sandboxed iframe (scripts run,
 * but with an opaque origin, no access to Shellie's page or IPC). Mounted only while shown.
 */
export function HtmlViewTab({
  taskId,
  view,
}: {
  taskId: string;
  view: HtmlView;
}) {
  const notify = useStore((s) => s.notify);
  const [loaded, setLoaded] = useState<Loaded>(null);
  // Reload asks main again (a deleted file then shows its error) and gives the iframe a fresh mount.
  const [reloads, setReloads] = useState(0);
  const target = docsTarget(taskId, view.workspaceId);

  useEffect(() => {
    let live = true;
    api()
      .invoke('html:open', target, view.path)
      .then(
        (r) => live && setLoaded(r),
        (e: unknown) => live && setLoaded({ error: errorMessage(e) }),
      );
    return () => {
      live = false;
    };
  }, [target, view.path, reloads]);

  return (
    <div className="htmlview">
      <div className="htmlview-toolbar">
        <span className="mono muted small htmlview-path" title={view.path}>
          {view.path}
        </span>
        <button
          type="button"
          className="btn btn-subtle btn-sm"
          onClick={() => setReloads((n) => n + 1)}
        >
          <ArrowClockwise16Regular aria-hidden="true" />
          Reload
        </button>
        <button
          type="button"
          className="btn btn-subtle btn-sm"
          onClick={() =>
            void tryInvoke(
              () => api().invoke('html:openExternal', target, view.path),
              notify,
            )
          }
        >
          <Open16Regular aria-hidden="true" />
          Open in browser
        </button>
      </div>
      {loaded && 'error' in loaded ? (
        <div role="alert" className="htmlview-error">
          {`Could not show ${view.name}: ${loaded.error}`}
        </div>
      ) : loaded ? (
        <iframe
          key={reloads}
          className="htmlview-frame"
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          src={loaded.url}
          title={loaded.name}
        />
      ) : null}
    </div>
  );
}
