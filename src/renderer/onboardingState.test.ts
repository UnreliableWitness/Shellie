import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../shared/usage';
import { firstScreen, nextStep, onboardingSteps } from './onboardingState';

const onboarding = (
  o: Partial<ReturnType<typeof defaultSettings>['onboarding']> = {},
) => ({
  onboarding: {
    dismissedAt: null,
    agentsCheckedAt: null,
    tracker: null,
    brain: null,
    migrated: false,
    ...o,
  },
});
const connection = { id: 'c1' };
const repo = { id: 'r1' };

describe('onboardingSteps', () => {
  it('a fresh install has every step to do, Agents first', () => {
    expect(
      onboardingSteps({
        settings: onboarding(),
        connections: [],
        repos: [],
        brains: [],
      }),
    ).toEqual({
      agents: 'todo',
      connect: 'todo',
      repository: 'todo',
      brain: 'todo',
      brainNeedsProject: true,
      current: 'agents',
    });
  });

  it('agents checked and no tracker chosen: Repository is next', () => {
    expect(
      onboardingSteps({
        settings: onboarding({ agentsCheckedAt: 'x', tracker: 'none' }),
        connections: [],
        repos: [],
        brains: [],
      }),
    ).toEqual({
      agents: 'done',
      connect: 'done',
      repository: 'todo',
      brain: 'done',
      brainNeedsProject: true,
      current: 'repository',
    });
  });

  it('a connection counts as connected; everything done leaves no current step', () => {
    expect(
      onboardingSteps({
        settings: onboarding({ agentsCheckedAt: 'x' }),
        connections: [connection],
        repos: [repo],
        brains: [{ id: 'b1' }],
      }),
    ).toEqual({
      agents: 'done',
      connect: 'done',
      repository: 'done',
      brain: 'done',
      brainNeedsProject: false,
      current: null,
    });
  });
});

describe('the brain step', () => {
  const base = { connections: [connection], repos: [repo] };
  it('is optional: done by a brain, by choosing none, or by having no tracker', () => {
    const at = (o: Parameters<typeof onboarding>[0], brains: unknown[]) =>
      onboardingSteps({
        ...base,
        settings: onboarding({ agentsCheckedAt: 'x', ...o }),
        brains,
      });
    expect(at({}, []).brain).toBe('todo');
    expect(at({}, []).current).toBe('brain');
    expect(at({}, [{ id: 'b' }]).brain).toBe('done');
    expect(at({ brain: 'none' }, []).brain).toBe('done');
    expect(at({ tracker: 'none' }, []).brain).toBe('done');
  });

  it('needs a project when there is no connection or the tracker is none', () => {
    const f = (c: unknown[], tracker: 'none' | null) =>
      onboardingSteps({
        settings: onboarding({ tracker }),
        connections: c,
        repos: [],
        brains: [],
      }).brainNeedsProject;
    expect(f([], null)).toBe(true);
    expect(f([connection], 'none')).toBe(true);
    expect(f([connection], null)).toBe(false);
  });
});

describe('firstScreen', () => {
  it('opens Get started without a repository until it is dismissed', () => {
    expect(firstScreen({ settings: onboarding(), repos: [] })).toBe(
      'get-started',
    );
    expect(
      firstScreen({ settings: onboarding({ dismissedAt: 'x' }), repos: [] }),
    ).toBe('home');
    expect(firstScreen({ settings: onboarding(), repos: [repo] })).toBe('home');
  });
});

describe('after a step page', () => {
  const steps = (
    o: Parameters<typeof onboarding>[0],
    c = 0,
    r = 0,
    brains: unknown[] = [],
  ) =>
    onboardingSteps({
      settings: onboarding(o),
      connections: Array(c).fill(connection),
      repos: Array(r).fill(repo),
      brains,
    });

  it('Continue goes to the next unfinished step page, else Home', () => {
    expect(nextStep(steps({ agentsCheckedAt: 'x' }), 'agents')).toEqual({
      kind: 'connect',
      from: 'get-started',
    });
    expect(nextStep(steps({ agentsCheckedAt: 'x' }, 1), 'agents')).toEqual({
      kind: 'add-repo',
      from: 'get-started',
    });
    expect(nextStep(steps({ agentsCheckedAt: 'x' }, 1, 1), 'agents')).toEqual({
      kind: 'brain-new',
      from: 'get-started',
    });
    expect(
      nextStep(steps({ agentsCheckedAt: 'x' }, 1, 1, [{}]), 'agents'),
    ).toEqual({ kind: 'home' });
  });

  it('Continue never returns to the step just left, even before its save lands', () => {
    expect(nextStep(steps({}), 'agents')).toEqual({
      kind: 'connect',
      from: 'get-started',
    });
  });
});

describe('after the repository step', () => {
  it('goes to the brain page while the brain is to do, else Home', () => {
    const o = { agentsCheckedAt: 'x' };
    const todo = onboardingSteps({
      settings: onboarding(o),
      connections: [connection],
      repos: [repo],
      brains: [],
    });
    expect(nextStep(todo, 'repository')).toEqual({
      kind: 'brain-new',
      from: 'get-started',
    });
    const done = onboardingSteps({
      settings: onboarding({ ...o, brain: 'none' }),
      connections: [connection],
      repos: [repo],
      brains: [],
    });
    expect(nextStep(done, 'repository')).toEqual({ kind: 'home' });
  });
});
