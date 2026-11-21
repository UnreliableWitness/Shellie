import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultBudgetSettings } from '../../shared/budget';
import { defaultDreaming, defaultDreamingAll } from '../../shared/dreams';
import { AppSettingsSchema, defaultSettings } from '../../shared/usage';
import { SettingsStore } from './SettingsStore';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'shellie-set-'));
  dirs.push(d);
  return path.join(d, 'settings.json');
};

describe('SettingsStore', () => {
  it('ignores writeCostToAdo and hourlySync from an old settings.json', async () => {
    const f = file();
    writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        receiverPort: 4319,
        hourlySync: true,
        writeCostToAdo: true,
      }),
    );
    const s = new SettingsStore(f);
    await s.load();
    expect('writeCostToAdo' in s.get()).toBe(false);
    expect('hourlySync' in s.get()).toBe(false);
  });

  it('defaults showSplash to true for files written before sub-project 6', async () => {
    const f = file();
    writeFileSync(
      f,
      JSON.stringify({ version: 1, receiverPort: 4319, hourlySync: true }),
    );
    const s = new SettingsStore(f);
    await s.load();
    expect(s.get().showSplash).toBe(true);
  });

  it('defaults onboarding for files written before it existed', async () => {
    const f = file();
    writeFileSync(
      f,
      JSON.stringify({ version: 1, receiverPort: 4319, hourlySync: true }),
    );
    const s = new SettingsStore(f);
    await s.load();
    expect(s.get().onboarding).toEqual({
      dismissedAt: null,
      agentsCheckedAt: null,
      tracker: null,
      brain: null,
      migrated: false,
    });
  });

  it('defaults, saves and reloads', async () => {
    const f = file();
    const a = new SettingsStore(f);
    await a.load();
    expect(a.get()).toEqual(defaultSettings());
    await a.save({
      ...defaultSettings(),
      receiverPort: 5000,
    });
    const b = new SettingsStore(f);
    await b.load();
    expect(b.get()).toMatchObject({ receiverPort: 5000 });
  });
  it('loads a settings file from sub-project 3 and drops the old keys on save', async () => {
    const f = file();
    writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        receiverPort: 5000,
        usdToEur: 0.95,
        markupPct: 15,
        hourlySync: false,
      }),
    );
    const s = new SettingsStore(f);
    expect(await s.load()).toEqual({ recovered: false });
    expect(s.get()).toEqual({
      version: 1,
      receiverPort: 5000,
      idleMinutes: 5,
      workHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
      showSplash: true,
      notifyOnDone: true,
      readingNudges: true,
      theme: 'system',
      claudeBudget: {
        monthlyEur: null,
        monthStartDay: 1,
        alerts: { at80: true, forecastOver: true, at100: true },
      },
      copilotBudget: {
        monthlyEur: null,
        monthStartDay: 1,
        alerts: { at80: true, forecastOver: true, at100: true },
      },
      sendTelemetry: true,
      editor: { default: null, repos: {} },
      secrets: { productionMinutes: 60 },
      dreaming: defaultDreamingAll(),
      onboarding: {
        dismissedAt: null,
        agentsCheckedAt: null,
        tracker: null,
        brain: null,
        migrated: false,
      },
      defaultTerminals: {
        claude: true,
        copilot: false,
        opencode: false,
        shell: true,
      },
    });
    await s.save({ ...s.get(), receiverPort: 5001 });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({
      version: 1,
      receiverPort: 5001,
      idleMinutes: 5,
      workHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
      showSplash: true,
      notifyOnDone: true,
      readingNudges: true,
      theme: 'system',
      claudeBudget: {
        monthlyEur: null,
        monthStartDay: 1,
        alerts: { at80: true, forecastOver: true, at100: true },
      },
      copilotBudget: {
        monthlyEur: null,
        monthStartDay: 1,
        alerts: { at80: true, forecastOver: true, at100: true },
      },
      sendTelemetry: true,
      editor: { default: null, repos: {} },
      secrets: { productionMinutes: 60 },
      dreaming: defaultDreamingAll(),
      onboarding: {
        dismissedAt: null,
        agentsCheckedAt: null,
        tracker: null,
        brain: null,
        migrated: false,
      },
      defaultTerminals: {
        claude: true,
        copilot: false,
        opencode: false,
        shell: true,
      },
    });
  });
  it('rejects invalid values', async () => {
    const s = new SettingsStore(file());
    await s.load();
    await expect(
      s.save({ ...defaultSettings(), receiverPort: 80 }),
    ).rejects.toThrow();
    expect(s.get().receiverPort).toBe(4319);
  });

  it('fills claudeBudget with defaults for older settings files', async () => {
    const f = file();
    writeFileSync(
      f,
      JSON.stringify({ version: 1, receiverPort: 4319, hourlySync: true }),
    );
    const s = new SettingsStore(f);
    await s.load();
    expect(s.get().claudeBudget).toEqual({
      monthlyEur: null,
      monthStartDay: 1,
      alerts: { at80: true, forecastOver: true, at100: true },
    });
  });

  it('rejects a month start day after 28', () => {
    expect(() =>
      AppSettingsSchema.parse({
        ...defaultSettings(),
        claudeBudget: { ...defaultBudgetSettings(), monthStartDay: 29 },
      }),
    ).toThrow();
  });
  it('loads a bad dreaming block as dreaming off and keeps every other setting', async () => {
    const f = file();
    writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        receiverPort: 4400,
        showSplash: false,
        // Hand-edited: a folder that is not a repo sub-path, and enabled as a string.
        dreaming: {
          enabled: 'yes',
          repos: { r1: { on: true, folders: ['.'] } },
        },
      }),
    );
    const s = new SettingsStore(f);
    expect(await s.load()).toEqual({ recovered: false });
    expect(s.get().dreaming).toEqual(defaultDreamingAll());
    expect(s.get().receiverPort).toBe(4400);
    expect(s.get().showSplash).toBe(false);
  });

  it('update() changes the value as it is when the write runs, after queued saves', async () => {
    const s = new SettingsStore(file());
    await s.load();
    const first = s.save({ ...s.get(), showSplash: false });
    const second = s.update((cur) => ({ ...cur, receiverPort: 4500 }));
    await Promise.all([first, second]);
    expect(s.get().showSplash).toBe(false);
    expect(s.get().receiverPort).toBe(4500);
  });
  describe('dreaming is written only through updateDreaming', () => {
    const on = (s: SettingsStore) =>
      s.updateDreamingOf('p1', (d) => ({
        ...d,
        enabled: true,
        model: 'zai/glm-5',
      }));
    const p1 = (s: SettingsStore) => s.get().dreaming.projects.p1;

    it('updateDreamingOf switches one project on and off and leaves the others', async () => {
      const s = new SettingsStore(file());
      await s.load();
      await on(s);
      await s.updateDreamingOf('p2', (d) => ({ ...d, idleMinutes: 30 }));
      expect(p1(s)).toMatchObject({ enabled: true, model: 'zai/glm-5' });
      await s.updateDreamingOf('p1', (d) => ({ ...d, enabled: false }));
      expect(p1(s).enabled).toBe(false);
      expect(s.get().dreaming.projects.p2).toEqual({
        ...defaultDreaming(),
        idleMinutes: 30,
      });
    });

    it('save and update keep the stored dreaming blocks as they are when the write runs', async () => {
      const s = new SettingsStore(file());
      await s.load();
      const block = { ...defaultDreaming(), enabled: true, idleMinutes: 99 };
      await s.save({
        ...s.get(),
        dreaming: { projects: { p1: block }, legacy: block },
      });
      await s.update((cur) => ({
        ...cur,
        dreaming: { projects: { p1: block }, legacy: null },
      }));
      expect(s.get().dreaming).toEqual(defaultDreamingAll());
    });

    it('update cannot get past the guard by changing the draft in place', async () => {
      const s = new SettingsStore(file());
      await s.load();
      await s.update((cur) => {
        cur.dreaming.projects.p1 = { ...defaultDreaming(), enabled: true };
        return cur;
      });
      expect(s.get().dreaming).toEqual(defaultDreamingAll());
    });

    it('a whole stale object saved after a switch-off leaves dreaming off', async () => {
      const s = new SettingsStore(file());
      await s.load();
      await on(s);
      const stale = s.get();
      // Queued together: the switch-off, then a writer that read the settings before it landed.
      const off = s.updateDreamingOf('p1', (d) => ({ ...d, enabled: false }));
      const late = s.save({ ...stale, showSplash: false });
      await Promise.all([off, late]);
      expect(p1(s).enabled).toBe(false);
      expect(s.get().showSplash).toBe(false);
    });

    it('updateDreamingOf keeps every other setting as it is when the write runs', async () => {
      const s = new SettingsStore(file());
      await s.load();
      const first = s.save({ ...s.get(), receiverPort: 4600 });
      const second = on(s);
      await Promise.all([first, second]);
      expect(s.get().receiverPort).toBe(4600);
      expect(p1(s).enabled).toBe(true);
    });
  });
});
