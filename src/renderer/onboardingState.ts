import type { AppSettings } from '../shared/usage';
import type { OnboardingStep } from './components/ui/StepStrip';
import type { Screen } from './store';

export type StepState = 'done' | 'todo';
export type OnboardingSteps = Record<OnboardingStep, StepState> & {
  /** True when the brain step has no project to build on: no tracker connected, or none chosen. */
  brainNeedsProject: boolean;
  /** The first unfinished step, null when all four are done. */
  current: OnboardingStep | null;
};

const ORDER = ['agents', 'connect', 'repository', 'brain'] as const;

type Inputs = {
  settings: Pick<AppSettings, 'onboarding'>;
  connections: readonly unknown[];
  repos: readonly unknown[];
  /** The brains that count: callers leave out archived ones. */
  brains: readonly unknown[];
};

/** Which first-run steps are done: agents checked, a tracker connected (or none chosen), a repository added, a brain made or skipped. */
export function onboardingSteps({
  settings,
  connections,
  repos,
  brains,
}: Inputs): OnboardingSteps {
  const { agentsCheckedAt, tracker } = settings.onboarding;
  const state = (done: boolean): StepState => (done ? 'done' : 'todo');
  const steps = {
    agents: state(agentsCheckedAt !== null),
    connect: state(connections.length > 0 || tracker === 'none'),
    repository: state(repos.length > 0),
    brain: state(
      brains.length > 0 ||
        settings.onboarding.brain === 'none' ||
        tracker === 'none',
    ),
  };
  const current = ORDER.find((k) => steps[k] === 'todo') ?? null;
  const brainNeedsProject = tracker === 'none' || connections.length === 0;
  return { ...steps, brainNeedsProject, current };
}

/** The page the app opens on: Get started until there is a repository or it was skipped. */
export function firstScreen({
  settings,
  repos,
}: Pick<Inputs, 'settings' | 'repos'>): 'get-started' | 'home' {
  return repos.length === 0 && settings.onboarding.dismissedAt === null
    ? 'get-started'
    : 'home';
}

/** Continue on step `left`'s page: the next unfinished step's page (never `left` again), else Home. */
export function nextStep(steps: OnboardingSteps, left: OnboardingStep): Screen {
  const next = ORDER.find((k) => k !== left && steps[k] === 'todo');
  switch (next) {
    case 'agents':
      return { kind: 'agents', from: 'get-started' };
    case 'connect':
      return { kind: 'connect', from: 'get-started' };
    case 'repository':
      return { kind: 'add-repo', from: 'get-started' };
    case 'brain':
      return { kind: 'brain-new', from: 'get-started' };
    default:
      return { kind: 'home' };
  }
}

const NOT_LOADED: Pick<AppSettings, 'onboarding'> = {
  onboarding: {
    dismissedAt: null,
    agentsCheckedAt: null,
    tracker: null,
    brain: null,
    migrated: false,
  },
};

/** The steps from the store's state; settings not loaded yet count as a fresh install. */
export function stepsFrom(s: {
  settings: Pick<AppSettings, 'onboarding'> | null;
  connections: readonly unknown[];
  repos: readonly unknown[];
  brains: readonly unknown[];
}): OnboardingSteps {
  return onboardingSteps({ ...s, settings: s.settings ?? NOT_LOADED });
}
