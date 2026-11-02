import { useEffect, useState } from 'react';
import { api, saveSettings, tryInvoke } from '../api';
import { useStore } from '../store';
import { minutesOf } from '../../shared/time';
import { type AppSettings, defaultSettings } from '../../shared/usage';
import { SettingRow, SettingsCategory } from './settings/SettingRow';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Draft = {
  start: string;
  end: string;
  days: number[];
  idleMinutes: string;
  writeTimeToAdo: boolean;
};

const toDraft = (s: AppSettings): Draft => ({
  start: s.workHours.start,
  end: s.workHours.end,
  days: s.workHours.days,
  idleMinutes: String(s.idleMinutes),
  writeTimeToAdo: s.writeTimeToAdo,
});

const sameDays = (a: number[], b: number[]) =>
  [...a].sort().join(',') === [...b].sort().join(',');

/** Settings: working hours, idle timeout and whether booked time goes to Azure DevOps. */
export function TimeSection() {
  const notify = useStore((s) => s.notify);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void tryInvoke(() => api().invoke('settings:get'), notify).then((s) => {
      if (live && s) {
        setDraft(toDraft(s));
        setSaved(s);
      }
    });
    return () => {
      live = false;
    };
  }, [notify]);

  const save = async () => {
    if (!draft) return;
    const idle = Number(draft.idleMinutes);
    if (!/^\d+$/.test(draft.idleMinutes.trim()) || idle < 1 || idle > 60) {
      setError('Idle minutes must be a whole number from 1 to 60');
      return;
    }
    if (
      !draft.start ||
      !draft.end ||
      minutesOf(draft.end) <= minutesOf(draft.start)
    ) {
      setError('Working hours must end after they start');
      return;
    }
    setError(null);
    const next = await tryInvoke(
      () =>
        saveSettings({
          idleMinutes: idle,
          writeTimeToAdo: draft.writeTimeToAdo,
          workHours: {
            start: draft.start,
            end: draft.end,
            days: [...draft.days].sort(),
          },
        }),
      notify,
    );
    if (next) {
      setSaved(next);
      notify('info', 'Settings saved');
    }
  };

  /** Puts one setting back to its default in the form and saves only that setting. */
  const reset = async (
    patch: (fresh: AppSettings) => Partial<AppSettings>,
    form: Partial<Draft>,
  ) => {
    setDraft((d) => d && { ...d, ...form });
    setError(null);
    const next = await tryInvoke(() => saveSettings(patch), notify);
    if (next) setSaved(next);
  };
  const resetHours = (
    change: (h: AppSettings['workHours']) => AppSettings['workHours'],
    form: Partial<Draft>,
  ) => reset((fresh) => ({ workHours: change(fresh.workHours) }), form);

  const defaults = defaultSettings();
  return (
    <SettingsCategory id="time" title="Time tracking">
      {draft && saved && (
        <>
          <SettingRow
            id="user-time-hours"
            category="Time tracking"
            title="Working hours"
            description="Wall clock time counts within these hours only."
            keywords={[
              'Working hours start',
              'Working hours end',
              'wall clock',
            ]}
            modified={
              saved.workHours.start !== defaults.workHours.start ||
              saved.workHours.end !== defaults.workHours.end
            }
            onReset={() =>
              void resetHours(
                (h) => ({
                  ...h,
                  start: defaults.workHours.start,
                  end: defaults.workHours.end,
                }),
                {
                  start: defaults.workHours.start,
                  end: defaults.workHours.end,
                },
              )
            }
          >
            <div className="conn-form">
              <label htmlFor="time-start">Working hours start</label>
              <input
                id="time-start"
                className="field mono"
                type="time"
                value={draft.start}
                onChange={(e) => setDraft({ ...draft, start: e.target.value })}
              />
              <label htmlFor="time-end">Working hours end</label>
              <input
                id="time-end"
                className="field mono"
                type="time"
                value={draft.end}
                onChange={(e) => setDraft({ ...draft, end: e.target.value })}
              />
            </div>
          </SettingRow>
          <SettingRow
            id="user-time-days"
            category="Time tracking"
            title="Working days"
            description="The days of the week that count as working days."
            keywords={DAYS}
            modified={!sameDays(saved.workHours.days, defaults.workHours.days)}
            onReset={() =>
              void resetHours(
                (h) => ({ ...h, days: defaults.workHours.days }),
                { days: defaults.workHours.days },
              )
            }
          >
            <div>
              {DAYS.map((d, i) => (
                <label key={d} className="checkbox">
                  <input
                    type="checkbox"
                    checked={draft.days.includes(i)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        days: e.target.checked
                          ? [...draft.days, i]
                          : draft.days.filter((x) => x !== i),
                      })
                    }
                  />
                  {d}
                </label>
              ))}
            </div>
          </SettingRow>
          <SettingRow
            id="user-time-idle"
            category="Time tracking"
            title="Idle minutes"
            description="Shellie time stops counting after this many minutes without input (1 to 60)."
            keywords={['timeout', 'away']}
            modified={saved.idleMinutes !== defaults.idleMinutes}
            onReset={() =>
              void reset(() => ({ idleMinutes: defaults.idleMinutes }), {
                idleMinutes: String(defaults.idleMinutes),
              })
            }
          >
            <input
              id="time-idle"
              aria-label="Idle minutes"
              className="field mono"
              type="number"
              min={1}
              max={60}
              value={draft.idleMinutes}
              onChange={(e) =>
                setDraft({ ...draft, idleMinutes: e.target.value })
              }
            />
          </SettingRow>
          <SettingRow
            id="user-time-ado"
            category="Time tracking"
            title="Write booked time to Azure DevOps"
            description="Off: the time stays in Shellie (Usage tab, CSV export)."
            keywords={['Completed Work', 'Remaining Work', 'book']}
            modified={saved.writeTimeToAdo !== defaults.writeTimeToAdo}
            onReset={() =>
              void reset(() => ({ writeTimeToAdo: defaults.writeTimeToAdo }), {
                writeTimeToAdo: defaults.writeTimeToAdo,
              })
            }
          >
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.writeTimeToAdo}
                onChange={(e) =>
                  setDraft({ ...draft, writeTimeToAdo: e.target.checked })
                }
              />
              Write booked time to Azure DevOps (adds to Completed Work, lowers
              Remaining Work)
            </label>
          </SettingRow>
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
        </>
      )}
    </SettingsCategory>
  );
}
