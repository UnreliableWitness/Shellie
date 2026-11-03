import { useEffect, useRef, useState } from 'react';
import type { WorkItemRef, WorkItemSummary } from '../../shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { StateDot, WorkItemTypeIcon } from './ui';

const DEBOUNCE_MS = 300;

export function WorkItemPicker({
  connectionId,
  selectedId,
  onPick,
}: {
  connectionId: string;
  selectedId: string | null;
  onPick: (item: WorkItemRef) => void;
}) {
  const notify = useStore((s) => s.notify);
  const [sprint, setSprint] = useState<string | null | undefined>(undefined);
  const [scope, setScope] = useState<'sprint' | 'mine'>('sprint');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<WorkItemSummary[]>([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [noSprintHint, setNoSprintHint] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    let live = true;
    setSprint(undefined);
    setNoSprintHint(false);
    api()
      .invoke('workItems:currentIteration', connectionId)
      .then((it) => {
        if (!live) return;
        setSprint(it ? it.name : null);
        if (!it) {
          setScope('mine');
          setNoSprintHint(true);
        }
      })
      .catch((e: Error) => {
        if (!live) return;
        notify('error', e.message);
        setSprint(null);
        setScope('mine');
        setNoSprintHint(false);
      });
    return () => {
      live = false;
    };
  }, [connectionId, notify]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    if (sprint === undefined) return;
    const mine = ++seq.current;
    setLoading(true);
    api()
      .invoke('workItems:search', connectionId, { scope, text: query })
      .then((found) => {
        if (mine !== seq.current) return;
        setItems(found);
        setFailed(false);
      })
      .catch((e: Error) => {
        if (mine !== seq.current) return;
        notify('error', e.message);
        setItems([]);
        setFailed(true);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [connectionId, scope, query, sprint, notify]);

  return (
    <div className="picker">
      <div className="picker-bar">
        <input
          className="field"
          aria-label="Search work items"
          placeholder="Search by title or paste an ID"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="pivots" role="group" aria-label="Scope">
          <button
            type="button"
            className="pivot"
            aria-pressed={scope === 'sprint'}
            disabled={sprint === null}
            onClick={() => setScope('sprint')}
          >
            Current sprint
          </button>
          <button
            type="button"
            className="pivot"
            aria-pressed={scope === 'mine'}
            onClick={() => setScope('mine')}
          >
            Assigned to me
          </button>
        </div>
        {sprint && scope === 'sprint' && (
          <span className="small muted">{sprint}</span>
        )}
      </div>
      {noSprintHint && (
        <div className="small muted">
          No current sprint in this project; showing work assigned to you.
        </div>
      )}
      <div className="grid picker-grid" aria-busy={loading}>
        <div className="grid-head" aria-hidden="true">
          <span />
          <span>ID</span>
          <span>Title</span>
          <span>State</span>
          <span>Assigned to</span>
        </div>
        <div className="grid-body">
          {failed && (
            <div className="empty">
              Could not load work items. Check the connection in Settings.
            </div>
          )}
          {sprint === undefined && <div className="empty">Loading...</div>}
          {sprint !== undefined &&
            !failed &&
            !loading &&
            items.length === 0 && (
              <div className="empty">No open work items match.</div>
            )}
          {items.map((w) => (
            <button
              key={w.id}
              type="button"
              className="grid-row"
              aria-pressed={selectedId === w.id}
              title={w.areaPath}
              onClick={() =>
                onPick({
                  id: w.id,
                  type: w.type,
                  title: w.title,
                  url: w.url,
                  project: w.project ?? null,
                })
              }
            >
              <WorkItemTypeIcon type={w.type} connectionId={connectionId} />
              <span className="grid-id">{w.id}</span>
              <span className="grid-title">{w.title}</span>
              <StateDot
                state={w.state}
                type={w.type}
                connectionId={connectionId}
              />
              <span className="grid-muted">{w.assignedTo ?? 'Unassigned'}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
