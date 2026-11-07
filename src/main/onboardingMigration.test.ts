import { describe, expect, it } from 'vitest';
import { defaultSettings, type AppSettings } from '../shared/usage';
import { migrateOnboarding } from './onboardingMigration';

const NOW = '2026-10-22T10:00:00.000Z';
const LATER = '2026-10-23T08:00:00.000Z';

/** One launch: the migration runs on the settings and whatever it returns is saved. */
const launch = (s: AppSettings, repos: number, now: string) =>
  migrateOnboarding(s, repos, now) ?? s;

describe('migrateOnboarding', () => {
  it('an install that already has repositories skips Get started and keeps its tabs', () => {
    const before = defaultSettings();
    const after = migrateOnboarding(before, 2, NOW);
    expect(after?.onboarding).toEqual({
      dismissedAt: NOW,
      agentsCheckedAt: NOW,
      tracker: null,
      brain: null,
      migrated: true,
    });
    expect(after?.defaultTerminals).toEqual(before.defaultTerminals);
  });

  it('a fresh install only records that the migration ran', () => {
    expect(migrateOnboarding(defaultSettings(), 0, NOW)?.onboarding).toEqual({
      dismissedAt: null,
      agentsCheckedAt: null,
      tracker: null,
      brain: null,
      migrated: true,
    });
  });

  it('fresh user, repo added, Agents skipped, relaunch: Agents stays to do and the band stays', () => {
    const first = launch(defaultSettings(), 0, NOW);
    // The user adds a repository from Get started and never opens Agents, then relaunches.
    const second = launch(first, 1, LATER);
    expect(second.onboarding).toEqual({
      dismissedAt: null,
      agentsCheckedAt: null,
      tracker: null,
      brain: null,
      migrated: true,
    });
    expect(migrateOnboarding(second, 1, LATER)).toBeNull();
  });

  it('runs once: settings already migrated are left alone', () => {
    const s = defaultSettings();
    expect(
      migrateOnboarding(
        { ...s, onboarding: { ...s.onboarding, migrated: true } },
        3,
        NOW,
      ),
    ).toBeNull();
  });

  it('settings with a timestamp keep it and are only marked migrated', () => {
    const s = defaultSettings();
    expect(
      migrateOnboarding(
        { ...s, onboarding: { ...s.onboarding, dismissedAt: 'earlier' } },
        3,
        NOW,
      )?.onboarding,
    ).toEqual({
      dismissedAt: 'earlier',
      agentsCheckedAt: null,
      tracker: null,
      brain: null,
      migrated: true,
    });
  });
});
