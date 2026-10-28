import { useState } from 'react';
import type { ModelTotals, UsageTool } from '../../shared/usage';
import {
  hourTicks,
  isLive,
  modelLegendName,
  modelShares,
  timeline,
  tokenMix,
  type Bin,
} from '../../shared/usageViews';
import { api, tryInvoke } from '../api';
import { compact, eur, shortEur } from '../format';
import { useClock } from '../hooks/useClock';
import { useTaskUsage } from '../hooks/useTaskUsage';
import { usageModelColor } from '../modelColor';
import { useStore } from '../store';
import { TimePanel } from './TimePanel';
import { Pivots, RingGauge } from './ui';
import { UsageLineage } from './UsageLineage';

const DOT = String.fromCharCode(0xb7);
const USAGE_TOOLS: UsageTool[] = ['claude-code', 'copilot-cli', 'opencode'];
const USAGE_TOOL_LABEL: Record<UsageTool, string> = {
  'claude-code': 'Claude Code',
  'copilot-cli': 'Copilot CLI',
  opencode: 'OpenCode',
};
const BIN_NAME: Record<UsageTool, string> = {
  'claude-code': 'Claude',
  'copilot-cli': 'Copilot',
  opencode: 'OpenCode',
};
const TOOL_FILL: Record<UsageTool, string> = {
  'claude-code': 'var(--chart-claude)',
  'copilot-cli': 'var(--chart-copilot)',
  opencode: 'var(--chart-opencode)',
};
const ARROW = String.fromCharCode(0x2192);
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
const DASH = String.fromCharCode(0x2013);

function binTitle(b: Bin): string {
  const range = `${clock(b.start)}${DASH}${clock(b.end)}`;
  if (b.costEur === 0) return `${range} ${DOT} no usage`;
  const parts = USAGE_TOOLS.filter((t) => b.byTool[t] > 0);
  const both =
    parts.length > 1
      ? ` (${parts.map((t) => `${BIN_NAME[t]} ${eur(b.byTool[t])}`).join(', ')})`
      : '';
  return `${range} ${DOT} ${eur(b.costEur)}${both}`;
}

function Timeline({ bins, live }: { bins: Bin[]; live: boolean }) {
  const maxBin = Math.max(0, ...bins.map((b) => b.costEur));
  const ticks = hourTicks(bins);
  return (
    <div className="up-chart">
      <div
        role="img"
        aria-label="Cost per 15 minutes, last 6 hours"
        className="up-timeline"
      >
        {bins.map((b, i) => {
          const fill = b.dominant
            ? TOOL_FILL[b.dominant]
            : 'var(--line-strong)';
          const cls = [
            'up-bin',
            live && i === bins.length - 1 ? 'is-live' : '',
            b.costEur > 0 ? '' : 'is-empty',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              key={b.start}
              data-part="bin"
              data-start={b.start}
              className={cls}
              title={binTitle(b)}
            >
              <span
                style={{
                  height:
                    maxBin > 0 && b.costEur > 0
                      ? `${(100 * b.costEur) / maxBin}%`
                      : undefined,
                  background: fill,
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="up-axis" aria-hidden="true">
        {ticks.map((t) => (
          <span
            key={t.at}
            data-part="tick"
            data-at={t.at}
            className={
              t.edge === 0
                ? 'is-first'
                : t.edge === bins.length
                  ? 'is-last'
                  : undefined
            }
            style={{ left: `${(100 * t.edge) / bins.length}%` }}
          >
            {clock(t.at)}
          </span>
        ))}
      </div>
    </div>
  );
}

function ModelLegend({ models }: { models: ModelTotals[] }) {
  const shares = modelShares(models);
  if (models.length === 0)
    return <div className="small muted">No usage yet</div>;
  return (
    <ul className="up-models" aria-label="Cost per model">
      {models.map((m, i) => (
        <li key={`${m.tool}-${m.label}`} data-part="model">
          <i className="dot" style={{ background: usageModelColor(m) }} />
          <span className="up-model-name" title={m.label}>
            {modelLegendName(m)}
          </span>
          <b className="mono">
            {m.costEur === 0 && m.unpricedRequests > 0
              ? 'unpriced'
              : eur(m.costEur)}
          </b>
          <span className="mono muted up-share">
            {shares[i] === 0
              ? ''
              : shares[i] < 0.005
                ? '<1%'
                : `${Math.round(shares[i] * 100)}%`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function UsagePanel({
  taskId,
  now = Date.now,
}: {
  taskId: string;
  now?: () => number;
}) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId));
  const notify = useStore((s) => s.notify);
  const usage = useTaskUsage(taskId);
  const [view, setView] = useState<'sessions' | 'lineage'>('sessions');
  // LIVE, the pulsing bin and the 6 h window must move on even when no new usage arrives.
  useClock(30_000);

  if (!task) return <div className="empty">Task not found</div>;

  const exportCsv = async () => {
    const csv = await tryInvoke(
      () => api().invoke('usage:exportCsv', taskId),
      notify,
    );
    if (csv === undefined) return;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `shellie-usage-${task.slug}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const setBillable = (sessionId: string, billable: boolean) =>
    tryInvoke(
      () => api().invoke('usage:setBillable', taskId, sessionId, billable),
      notify,
    );

  const t = now();
  const total = usage?.billable.costEur ?? 0;
  const models = usage?.byModel ?? [];
  const priced = models.filter((m) => m.costEur > 0);
  const bins = timeline(usage?.recent ?? [], t);
  const windowEur = bins.reduce((n, b) => n + b.costEur, 0);
  const mix = usage ? tokenMix(usage) : null;
  const mixRows = mix
    ? [
        ['Cache read', mix.cacheRead],
        ['Input', mix.input],
        ['Cache write', mix.cacheWrite],
        ['Output', mix.output],
      ]
    : [];
  const mixMax = Math.max(1, ...mixRows.map(([, v]) => v as number));
  const anyLive = usage ? usage.sessions.some((s) => isLive(s, t)) : false;

  return (
    <section className="usagepanel" aria-label="AI usage">
      <div className="up-col up-instrument">
        <div className="card up-box up-billable">
          <h3>Billable</h3>
          <RingGauge
            size={150}
            value={total}
            max={Math.max(
              priced.reduce((n, m) => n + m.costEur, 0),
              0.0001,
            )}
            label={`Billable ${eur(total)}`}
            center={{
              value: shortEur(total),
              caption: 'total',
            }}
            segments={priced.map((m) => ({
              value: m.costEur,
              color: usageModelColor(m),
              title: `${modelLegendName(m)} ${DOT} ${eur(m.costEur)}`,
            }))}
          />
          <ModelLegend models={models} />
        </div>
        <div className="card up-box">
          <div className="up-head">
            <h3>Tokens</h3>
            <span className="mono small muted" data-testid="tokens-total">
              {compact(usage?.billable.tokens ?? 0)}
            </span>
          </div>
          {mixRows.map(([label, v]) => (
            <div key={label} className="up-mixrow">
              <span className="small muted">{label}</span>
              <span className="mono small">{compact(v as number)}</span>
              <div className="up-bar">
                <span style={{ width: `${((v as number) / mixMax) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
        {usage && (
          <div className="up-caption mono">{`Official list prices ${DOT} USD${ARROW}EUR ${usage.usdToEur}`}</div>
        )}
      </div>
      <div className="up-col up-main">
        <TimePanel taskId={taskId} />
        <div className="card up-box">
          <div className="up-head">
            <h3>Last 6 hours</h3>
            <span className="small muted">
              {`${eur(windowEur)} in 6 h ${DOT} 15 min bars`}
            </span>
          </div>
          <Timeline bins={bins} live={anyLive} />
        </div>
        {usage && usage.unpricedRequests > 0 && (
          <div className="check check-warn">{`${usage.unpricedRequests} ${usage.unpricedRequests === 1 ? 'request uses a model' : 'requests use models'} that ${usage.unpricedRequests === 1 ? 'is' : 'are'} not in Shellie's official price list yet, so ${usage.unpricedRequests === 1 ? 'it is' : 'they are'} not in the totals. A Shellie update will add ${usage.unpricedRequests === 1 ? 'it' : 'them'}.`}</div>
        )}
        <div className="card up-box up-sessions">
          <div className="up-head">
            <h3>{`Sessions ${DOT} ${usage?.sessions.length ?? 0}`}</h3>
            <Pivots
              label="Usage view"
              items={[
                { key: 'sessions', label: 'Sessions' },
                { key: 'lineage', label: 'Lineage' },
              ]}
              selected={view}
              onSelect={setView}
            />
          </div>
          {usage && usage.sessions.length === 0 ? (
            <div className="empty">
              No AI usage captured for this task yet. Claude Code, Copilot CLI
              and OpenCode started in this task&apos;s terminals report here
              automatically.
            </div>
          ) : usage && view === 'lineage' ? (
            <UsageLineage
              nodes={usage.lineage ?? []}
              rootName={(n) =>
                `${USAGE_TOOL_LABEL[n.tool]} ${DOT} ${when(n.startedAt)}`
              }
            />
          ) : (
            usage && (
              <table>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Tool</th>
                    <th>Model</th>
                    <th>Tokens</th>
                    <th>EUR</th>
                    <th>Bill</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.sessions.map((s) => (
                    <tr
                      key={s.sessionId}
                      className={s.billable ? undefined : 'is-excluded'}
                    >
                      <td>
                        {when(s.startedAt)}
                        {isLive(s, t) && (
                          <span className="live mono">LIVE</span>
                        )}
                      </td>
                      <td>{USAGE_TOOL_LABEL[s.tool]}</td>
                      <td className="mono">{s.models.join(', ')}</td>
                      <td className="mono">
                        {compact(
                          s.inputTokens +
                            s.outputTokens +
                            s.cacheReadTokens +
                            s.cacheWriteTokens,
                        )}
                      </td>
                      <td className="mono eur">
                        {s.unpricedRequests === s.requests
                          ? 'unpriced'
                          : `${eur(s.costUsd * usage.usdToEur)}${s.unpricedRequests > 0 ? ' + unpriced' : ''}`}
                      </td>
                      <td>
                        <label className="switch">
                          <input
                            type="checkbox"
                            aria-label="Billable"
                            checked={s.billable}
                            onChange={(e) =>
                              void setBillable(s.sessionId, e.target.checked)
                            }
                          />
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
        <div className="card up-box up-workitem">
          <h3>Export</h3>
          <p className="muted small">
            The cost stays in Shellie: this tab and the CSV export.
          </p>
          <div className="actions">
            <button type="button" className="btn" onClick={exportCsv}>
              CSV
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
