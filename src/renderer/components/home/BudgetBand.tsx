import { useEffect, useState } from 'react';
import type { Vendor } from '../../../shared/budget';
import type { BudgetView } from '../../../shared/budgetView';
import { compact, eur } from '../../format';
import { useBudget } from '../../hooks/useBudget';
import { modelColor } from '../../modelColor';
import { useStore } from '../../store';
import { track } from '../../telemetry';
import { CaptureOffLine } from '../CaptureOffLine';
import { Band } from './Band';

const INFO: Record<Vendor, string> = {
  claude:
    "Estimated at Anthropic API list prices in EUR. Your company's invoice may differ. Claude models through GitHub Copilot count in the Copilot budget.",
  copilot:
    "Estimated at GitHub Copilot list prices in EUR. Credits included with your seat aren't subtracted.",
};
const TITLE: Record<Vendor, string> = {
  claude: 'Claude budget',
  copilot: 'Copilot budget',
};

export { modelColor };
const PROVIDERS: Record<string, string> = {
  'github-copilot': 'GitHub Copilot',
  openai: 'OpenAI',
};
const providerName = (id: string) => PROVIDERS[id] ?? id;
const monthName = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short' });
const shortDate = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });

const WARN = String.fromCharCode(0x26a0);
const unpricedSentence = (x: BudgetView['unpriced'][number]) =>
  `Not in the total: no price for ${x.model} (${compact(x.tokens)} tokens)`;

/** Next to the headline amount while the period has usage without a price: the amount is too low. */
function UnpricedMark({ v }: { v: BudgetView }) {
  if (v.unpriced.length === 0) return null;
  const words = v.unpriced.map(unpricedSentence).join('\n');
  return (
    <span
      role="img"
      className="budget-warn-mark"
      title={words}
      aria-label={words}
    >
      {WARN}
    </span>
  );
}

function Status({ v }: { v: BudgetView }) {
  if (v.status === 'over' && v.budgetEur !== null)
    return (
      <span className="budget-status is-over">
        Over budget by {eur(v.spentEur - v.budgetEur)}
      </span>
    );
  if (v.status === 'paceOver' && v.forecastEur !== null && v.budgetEur !== null)
    return (
      <span className="budget-status is-over">
        On pace for {eur(v.forecastEur)}, {eur(v.forecastEur - v.budgetEur)}{' '}
        over
      </span>
    );
  if (v.forecastEur !== null && v.status === 'none')
    return (
      <span className="budget-status">
        About {eur(v.forecastEur)} by {shortDate(v.endDay)}
      </span>
    );
  if (v.forecastEur !== null)
    return (
      <span className="budget-status">
        On track: about {eur(v.forecastEur)} by {shortDate(v.endDay)}
      </span>
    );
  return null;
}

const ALLOWANCE_INFO =
  'What is left of the monthly budget, spread over the days left including today.';

function Today({ v }: { v: BudgetView }) {
  const allowance = v.todayAllowanceEur;
  const over = allowance !== null && v.todayEur > allowance;
  return (
    <div className={`budget-today${over ? ' is-over' : ''}`}>
      <b>{eur(v.todayEur)}</b>{' '}
      {allowance === null ? (
        <span className="muted">today</span>
      ) : (
        <>
          <span className="muted" title={ALLOWANCE_INFO}>
            today of {eur(allowance)}
          </span>
          <span className="budget-today-note">
            {over
              ? `${eur(v.todayEur - allowance)} over today`
              : `${eur(allowance - v.todayEur)} left today`}
          </span>
          <span className="budget-meter" aria-hidden="true">
            <i
              style={{
                width: `${allowance > 0 ? Math.min(100, (100 * v.todayEur) / allowance) : 100}%`,
              }}
            />
          </span>
        </>
      )}
    </div>
  );
}

const W = 600;
function BurnDown({ v }: { v: BudgetView }) {
  const n = v.daysInMonth;
  const top =
    Math.max(v.budgetEur ?? 0, v.forecastEur ?? 0, v.spentEur, 1) * 1.05;
  const x = (i: number) => (W * i) / Math.max(1, n - 1);
  const y = (eurValue: number) => 90 - (85 * eurValue) / top;
  const line = v.cumulative.map((p, i) => `${x(i)},${y(p.eur)}`).join(' ');
  const last = v.cumulative.length - 1;
  return (
    <svg
      role="img"
      aria-label="Spend this month against the budget"
      viewBox={`0 0 ${W} 92`}
      preserveAspectRatio="none"
      className="budget-burn"
    >
      {v.budgetEur !== null && (
        <>
          <line
            x1={0}
            y1={y(v.budgetEur)}
            x2={W}
            y2={y(v.budgetEur)}
            className="budget-limit"
          />
          <line
            x1={0}
            y1={y(0)}
            x2={W}
            y2={y(v.budgetEur)}
            className="budget-pace"
          />
        </>
      )}
      <polyline points={line} className="budget-line" />
      {v.cumulative.map((p, i) => {
        // Centred on the day's point; one point per day, n - 1 steps across.
        const step = W / Math.max(1, n - 1);
        return (
          <rect
            key={p.day}
            data-part="burn-hit"
            x={x(i) - step / 2}
            y={0}
            width={step}
            height={92}
            fill="transparent"
            pointerEvents="all"
          >
            <title>{`${shortDate(p.day)}: ${eur(p.eur)}`}</title>
          </rect>
        );
      })}
      {v.forecastEur !== null && last >= 0 && (
        <line
          x1={x(last)}
          y1={y(v.cumulative[last].eur)}
          x2={W}
          y2={y(v.forecastEur)}
          className="budget-forecast"
        />
      )}
    </svg>
  );
}

function DailyBars({ v }: { v: BudgetView }) {
  const max = Math.max(...v.days.map((d) => d.costEur), 0.01);
  const bw = W / Math.max(1, v.days.length);
  return (
    <svg
      role="img"
      aria-label="Spend per day by model"
      viewBox={`0 0 ${W} 60`}
      preserveAspectRatio="none"
      className="budget-bars"
    >
      <defs>
        <pattern
          id="budget-hatch"
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="2" height="4" fill="var(--bg-card)" opacity="0.85" />
        </pattern>
      </defs>
      {v.days.map((d, i) => {
        let yTop = 60;
        return (
          <g
            key={d.day}
            data-part="day"
            className={d.today ? 'is-today' : undefined}
          >
            <title>{`${shortDate(d.day)}: ${eur(d.costEur)}${d.byModel.map((m) => `\n${m.model} ${eur(m.costEur)} · ${compact(m.tokens)} tokens`).join('')}`}</title>
            {d.byModel.map((m) => {
              const h = (58 * m.costEur) / max;
              yTop -= h;
              const hOut = (58 * m.outsideEur) / max;
              return (
                <g key={m.model}>
                  <rect
                    x={i * bw + 1}
                    y={yTop}
                    width={bw - 2}
                    height={h}
                    fill={modelColor(m.model)}
                  />
                  {hOut > 0 && (
                    <rect
                      x={i * bw + 1}
                      y={yTop}
                      width={bw - 2}
                      height={hOut}
                      fill="url(#budget-hatch)"
                    />
                  )}
                </g>
              );
            })}
            {d.today && (
              <rect
                data-part="today-outline"
                x={i * bw + 0.5}
                y={Math.min(yTop, 56) - 0.5}
                width={bw - 1}
                height={60 - Math.min(yTop, 56) + 0.5}
                fill="none"
                stroke="var(--text)"
                strokeWidth={1}
                strokeDasharray="2 2"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function BudgetBand({ vendor }: { vendor: Vendor }) {
  const [offset, setOffset] = useState(0);
  const v = useBudget(vendor, offset);
  const go = useStore((s) => s.go);
  const step = (d: number) => {
    track('home.clicked', { band: 'budget-month' });
    setOffset((o) => Math.min(0, o + d));
  };
  // Copilot is optional: no band until this month has spend, a budget or unpriced
  // usage. Once shown it stays, so stepping to an empty month cannot hide it.
  const [revealed, setRevealed] = useState(vendor === 'claude');
  const hasUsage =
    !!v &&
    offset === 0 &&
    (v.spentEur > 0 || v.budgetEur !== null || v.unpriced.length > 0);
  useEffect(() => {
    if (hasUsage) setRevealed(true);
  }, [hasUsage]);
  if (!revealed) return null;
  return (
    <Band title={TITLE[vendor]}>
      {vendor === 'claude' && <CaptureOffLine />}
      {v && (
        <div className="budget">
          <div className="budget-head">
            <button
              type="button"
              className="icon-btn"
              aria-label="Previous month"
              onClick={() => step(-1)}
            >
              ‹
            </button>
            <span className="muted small">
              {shortDate(v.startDay)} – {shortDate(v.endDay)}
            </span>
            {offset < 0 && (
              <button
                type="button"
                className="icon-btn"
                aria-label="Next month"
                onClick={() => step(1)}
              >
                ›
              </button>
            )}
          </div>
          {!v.scanned ? (
            <p className="muted">
              Reading {vendor === 'claude' ? 'Claude' : 'Copilot'} usage…
            </p>
          ) : vendor === 'claude' &&
            !v.sources.claudeCode &&
            !v.sources.openCode ? (
            <p className="muted">
              No Claude Code or OpenCode usage found on this computer.
            </p>
          ) : (
            <>
              <div className="budget-total">
                {v.budgetEur === null ? (
                  <>
                    <b>
                      {eur(v.spentEur)}{' '}
                      {offset < 0
                        ? `in ${monthName(v.startDay)}`
                        : 'this month'}
                    </b>
                    <UnpricedMark v={v} />
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        track('home.clicked', { band: 'budget-settings' });
                        go({ kind: 'settings', section: 'budgets' });
                      }}
                    >
                      Set a monthly budget
                    </button>
                  </>
                ) : (
                  <>
                    <b>{eur(v.spentEur)}</b>
                    <UnpricedMark v={v} />{' '}
                    <span className="muted">of {eur(v.budgetEur)}</span>
                  </>
                )}
                <span
                  className="budget-info"
                  title={INFO[vendor]}
                  aria-label={INFO[vendor]}
                >
                  ⓘ
                </span>
                {offset === 0 && <Today v={v} />}
                <Status v={v} />
              </div>
              <BurnDown v={v} />
              <DailyBars v={v} />
              <ul className="budget-models">
                {v.models.map((m) => (
                  <li key={m.model}>
                    <i style={{ background: modelColor(m.model) }} /> {m.model}{' '}
                    {eur(m.costEur)}
                  </li>
                ))}
              </ul>
              {offset === 0 && (
                <p className="muted small">{`This week ${eur(v.weekEur)} · ${Math.round(v.outsideShare * 100)}% outside Shellie`}</p>
              )}
              {v.notCounted.map((x) => (
                <p
                  key={`${x.provider}|${x.model}`}
                  className="muted small"
                >{`Not in a budget: ${x.model} via ${providerName(x.provider)}, ${x.requests} requests`}</p>
              ))}
              {v.unpriced.map((x) => (
                <p key={x.model} className="budget-warn small">
                  {unpricedSentence(x)}
                </p>
              ))}
            </>
          )}
        </div>
      )}
    </Band>
  );
}
