import { ArrowClockwise16Regular } from '@fluentui/react-icons';
import { useEffect, useMemo } from 'react';
import { Band } from '../components/home/Band';
import { GetStartedBand } from '../components/home/GetStartedBand';
import { PrBand } from '../components/home/PrBand';
import { SprintsBand } from '../components/home/SprintsBand';
import { BudgetBand } from '../components/home/BudgetBand';
import { StatsBand } from '../components/home/StatsBand';
import { TasksBand } from '../components/home/TasksBand';
import { WhatsNewBand } from '../components/home/WhatsNewBand';
import { PageHeader } from '../components/ui';
import { ago } from '../format';
import { useClock } from '../hooks/useClock';
import { useHome } from '../hooks/useHome';
import { chipState } from '../homeView';
import { useStore } from '../store';
import { track } from '../telemetry';
import { useWorkItemTypes } from '../workItemTypes';

const CHIP_TEXT = {
  ok: 'connected',
  stale: 'stale',
  error: 'not connected',
} as const;

export function HomeScreen() {
  const { snapshot: raw, refreshing, refresh } = useHome();
  useClock(60_000);
  const connections = useStore((s) => s.connections);
  // A removed connection's rows stay in the cached snapshot until the next rebuild; show none of them.
  const snapshot = useMemo(
    () =>
      raw && {
        ...raw,
        connections: raw.connections.filter((h) =>
          connections.some((c) => c.id === h.connectionId),
        ),
      },
    [raw, connections],
  );
  const go = useStore((s) => s.go);
  const setConnectionId = useStore((s) => s.setConnectionId);
  const loadTypes = useWorkItemTypes((s) => s.load);
  useEffect(() => {
    for (const c of snapshot?.connections ?? []) loadTypes(c.connectionId);
  }, [snapshot, loadTypes]);
  const byId = new Map(snapshot?.connections.map((c) => [c.connectionId, c]));
  const refused = connections.filter((c) => c.status === 'unauthorized');
  return (
    <div className="page home">
      <PageHeader
        title="Home"
        after={
          snapshot && (
            <span className="muted small home-updated">
              {refreshing ? 'Updating' : `Updated ${ago(snapshot.builtAt)}`}
            </span>
          )
        }
        commands={
          <>
            <div className="home-chips">
              {connections.map((c) => {
                const h = byId.get(c.id);
                const state = chipState(h, c);
                const detail =
                  state === 'ok'
                    ? CHIP_TEXT.ok
                    : `${CHIP_TEXT[state]}${h?.error ? `: ${h.error}` : ''}`;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`home-chip is-${state}`}
                    aria-label={`${c.name}: ${c.project}, ${detail}`}
                    title={detail}
                    onClick={() => {
                      setConnectionId(c.id);
                      go({ kind: 'project' });
                      track('project.open', { from: 'home' });
                    }}
                  >
                    <span className="dot" />
                    {c.name}/{c.project}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="btn"
              aria-label="Refresh"
              disabled={refreshing}
              onClick={refresh}
            >
              <ArrowClockwise16Regular aria-hidden="true" />
            </button>
          </>
        }
      />
      {refused.map((c) => (
        <p key={c.id} className="home-warning" role="status">
          Azure DevOps refused the token for {c.name}/{c.project}. Update it in{' '}
          <button type="button" onClick={() => go({ kind: 'settings' })}>
            Settings
          </button>
          .
        </p>
      ))}
      <div className="home-bands">
        <WhatsNewBand />
        <GetStartedBand />
        <TasksBand snapshot={snapshot} />
        {connections.length > 0 && (
          <>
            {snapshot ? (
              <PrBand snapshot={snapshot} />
            ) : (
              <div className="home-split">
                <Band title="Reviews for me">
                  <p className="muted">Loading</p>
                </Band>
                <Band title="My pull requests">
                  <p className="muted">Loading</p>
                </Band>
              </div>
            )}
            {snapshot ? (
              <SprintsBand snapshot={snapshot} />
            ) : (
              <Band title="My sprints">
                <p className="muted">Loading</p>
              </Band>
            )}
          </>
        )}
        <StatsBand />
        <BudgetBand vendor="claude" />
        <BudgetBand vendor="copilot" />
      </div>
    </div>
  );
}
