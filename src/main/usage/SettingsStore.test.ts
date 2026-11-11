import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultBudgetSettings } from '../../shared/budget';
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
});
