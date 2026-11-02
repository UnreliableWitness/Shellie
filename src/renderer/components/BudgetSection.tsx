import { useEffect, useState } from 'react';
import { type BudgetSettings, type Vendor, VENDORS } from '../../shared/budget';
import { api, saveSettings, tryInvoke } from '../api';
import { type AppSettings, defaultSettings } from '../../shared/usage';
import { useStore } from '../store';
import { SettingRow, SettingsCategory } from './settings/SettingRow';
import { useCostServerStatus } from './CostServerSection';

type Draft = {
  monthlyEur: string;
  monthStartDay: string;
  alerts: BudgetSettings['alerts'];
};
type Drafts = Record<Vendor, Draft>;

const NAMES: Record<Vendor, string> = { claude: 'Claude', copilot: 'Copilot' };
const KEYS = { claude: 'claudeBudget', copilot: 'copilotBudget' } as const;
const HELP: Record<Vendor, string> = {
  claude:
    'Your monthly Claude budget from your company. Home shows the spend of Claude Code and OpenCode (Anthropic) on this computer against it.',
  copilot:
    'Your monthly GitHub Copilot budget. Home shows the spend of Copilot CLI and OpenCode (GitHub Copilot) on this computer against it, including Claude models used through Copilot.',
};

const toDraft = (b: BudgetSettings): Draft => ({
  monthlyEur: b.monthlyEur === null ? '' : String(b.monthlyEur),
  monthStartDay: String(b.monthStartDay),
  alerts: b.alerts,
});

/** Settings: the monthly Claude and Copilot budgets, their reset days and which warnings to show. */
export function BudgetSection({
  managed: managedProp,
}: {
  /** A budget set by the cost server: its amount and start day are read-only. Default: from the cost server status. */
  managed?: Record<Vendor, boolean>;
}) {
  const notify = useStore((s) => s.notify);
  const [server] = useCostServerStatus();
  const tiers = server?.budgets ?? null;
  const managed = managedProp ?? {
    claude: Boolean(tiers?.claude),
    copilot: Boolean(tiers?.copilot),
  };
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void tryInvoke(() => api().invoke('settings:get'), notify).then((s) => {
      if (!live || !s) return;
      setSaved(s);
      setDrafts({
        claude: toDraft(s.claudeBudget),
        copilot: toDraft(s.copilotBudget),
      });
    });
    return () => {
      live = false;
    };
  }, [notify]);

  const save = async () => {
    if (!drafts) return;
    const patch: Partial<Record<(typeof KEYS)[Vendor], BudgetSettings>> = {};
    for (const vendor of VENDORS) {
      const draft = drafts[vendor];
      const raw = draft.monthlyEur.trim();
      const monthlyEur = raw === '' ? null : Number(raw);
      if (managed[vendor]) {
        // The server sets the amount and start day: keep the local ones as they were, save the alerts.
        patch[KEYS[vendor]] = {
          monthlyEur,
          monthStartDay: Number(draft.monthStartDay),
          alerts: draft.alerts,
        };
        continue;
      }
      if (
        monthlyEur !== null &&
        !(Number.isFinite(monthlyEur) && monthlyEur > 0)
      ) {
        setError(
          `The ${NAMES[vendor]} budget must be a positive amount, or empty for none.`,
        );
        return;
      }
      const day = Number(draft.monthStartDay);
      if (!/^\d+$/.test(draft.monthStartDay.trim()) || day < 1 || day > 28) {
        setError('Month start day must be 1 to 28.');
        return;
      }
      patch[KEYS[vendor]] = {
        monthlyEur,
        monthStartDay: day,
        alerts: draft.alerts,
      };
    }
    setError(null);
    const next = await tryInvoke(() => saveSettings(patch), notify);
    if (next) {
      setSaved(next);
      notify('info', 'Settings saved');
    }
  };

  const update = (vendor: Vendor, next: Partial<Draft>) =>
    setDrafts((d) => d && { ...d, [vendor]: { ...d[vendor], ...next } });

  /** Puts one part of a budget back to its default in the form and saves only that part. */
  const reset = async (
    vendor: Vendor,
    part: Partial<BudgetSettings>,
    form: Partial<Draft>,
  ) => {
    update(vendor, form);
    setError(null);
    const next = await tryInvoke(
      () =>
        saveSettings((fresh) => ({
          [KEYS[vendor]]: { ...fresh[KEYS[vendor]], ...part },
        })),
      notify,
    );
    if (next) setSaved(next);
  };

  const alertBox = (
    vendor: Vendor,
    key: keyof Draft['alerts'],
    label: string,
  ) =>
    drafts && (
      <label className="checkbox">
        <input
          type="checkbox"
          checked={drafts[vendor].alerts[key]}
          onChange={(e) =>
            update(vendor, {
              alerts: { ...drafts[vendor].alerts, [key]: e.target.checked },
            })
          }
        />
        {label}
      </label>
    );

  const defaults = defaultSettings();
  return (
    <SettingsCategory id="budgets" title="Budgets">
      {drafts &&
        saved &&
        VENDORS.map((vendor) => {
          const locked = managed[vendor];
          const tier = tiers?.[vendor];
          const name = NAMES[vendor];
          const stored = saved[KEYS[vendor]];
          const initial = defaults[KEYS[vendor]];
          // A managed budget shows the server's amount and start day, not the local ones.
          const d =
            locked && tier
              ? {
                  ...drafts[vendor],
                  monthlyEur: String(tier.monthlyEur),
                  monthStartDay: String(tier.monthStartDay),
                }
              : drafts[vendor];
          const alertsChanged = (
            Object.keys(initial.alerts) as (keyof Draft['alerts'])[]
          ).some((k) => stored.alerts[k] !== initial.alerts[k]);
          return (
            <div key={vendor} role="group" aria-label={`${name} budget`}>
              <SettingRow
                id={`user-budget-${vendor}-amount`}
                category="Budgets"
                title={`${name} monthly budget`}
                description={HELP[vendor]}
                keywords={['Monthly budget', 'EUR', 'spend', 'limit']}
                modified={!locked && stored.monthlyEur !== initial.monthlyEur}
                onReset={
                  locked
                    ? undefined
                    : () =>
                        void reset(
                          vendor,
                          { monthlyEur: initial.monthlyEur },
                          { monthlyEur: toDraft(initial).monthlyEur },
                        )
                }
              >
                <input
                  id={`budget-eur-${vendor}`}
                  aria-label="Monthly budget (€)"
                  className="field mono"
                  type="number"
                  min={1}
                  step="any"
                  placeholder="No budget"
                  disabled={locked}
                  value={d.monthlyEur}
                  onChange={(e) =>
                    update(vendor, { monthlyEur: e.target.value })
                  }
                />
                {locked && (
                  <>
                    {' '}
                    <span className="small muted">Set by your cost server</span>
                  </>
                )}
              </SettingRow>
              <SettingRow
                id={`user-budget-${vendor}-start`}
                category="Budgets"
                title={`${name} month start`}
                description="The day of the month the budget starts again (1 to 28)."
                keywords={['Month starts on day', 'month start day', 'reset']}
                modified={
                  !locked && stored.monthStartDay !== initial.monthStartDay
                }
                onReset={
                  locked
                    ? undefined
                    : () =>
                        void reset(
                          vendor,
                          { monthStartDay: initial.monthStartDay },
                          { monthStartDay: toDraft(initial).monthStartDay },
                        )
                }
              >
                <input
                  id={`budget-day-${vendor}`}
                  aria-label="Month starts on day"
                  className="field mono"
                  type="number"
                  min={1}
                  max={28}
                  disabled={locked}
                  value={d.monthStartDay}
                  onChange={(e) =>
                    update(vendor, { monthStartDay: e.target.value })
                  }
                />
              </SettingRow>
              <SettingRow
                id={`user-budget-${vendor}-alerts`}
                category="Budgets"
                title={`${name} warnings`}
                description="Which warnings Home shows for this budget."
                keywords={['alerts', '80%', 'forecast', 'used up']}
                modified={alertsChanged}
                onReset={() =>
                  void reset(
                    vendor,
                    { alerts: initial.alerts },
                    { alerts: initial.alerts },
                  )
                }
              >
                <div>
                  {alertBox(vendor, 'at80', 'Warn at 80% of the budget')}
                  {alertBox(
                    vendor,
                    'forecastOver',
                    'Warn when the forecast goes over',
                  )}
                  {alertBox(vendor, 'at100', 'Warn when the budget is used up')}
                </div>
              </SettingRow>
            </div>
          );
        })}
      {drafts && saved && (
        <div className="settings-actions">
          <button type="button" className="btn btn-primary" onClick={save}>
            Save
          </button>
          {error && (
            <div role="alert" className="conn-status-bad">
              {error}
            </div>
          )}
        </div>
      )}
    </SettingsCategory>
  );
}
