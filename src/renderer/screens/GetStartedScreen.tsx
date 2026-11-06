import { useEffect, useState } from 'react';
import {
  AGENT_IDS,
  AGENT_LABELS,
  type AgentsDetected,
} from '../../shared/agents';
import type { DefaultTerminals } from '../../shared/terminals';
import { api, saveSettings, tryInvoke } from '../api';
import { pretick } from '../agentsPretick';
import { MindMark } from '../components/ui';
import type { OnboardingStep } from '../components/ui/StepStrip';
import { stepsFrom } from '../onboardingState';
import { useStore } from '../store';
import { track } from '../telemetry';

// The art is picked later (tools/art/prompts.md); until the file exists the box shows the app icon.
const ART = Object.values(
  import.meta.glob<string>('../../../assets/art/get-started.jpg', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
)[0];

const list = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** Card 1's line: what was found and which tabs a new task opens. */
function agentsLine(
  detected: AgentsDetected | null,
  tabs: DefaultTerminals | undefined,
): string {
  const found = detected
    ? AGENT_IDS.filter((id) => detected.agents[id].found).map((id) => {
        const v = detected.agents[id].version;
        return v ? `${AGENT_LABELS[id]} ${v}` : AGENT_LABELS[id];
      })
    : [];
  const foundText = !detected
    ? ''
    : found.length
      ? `Found ${list(found)} on this machine. `
      : 'No agent CLI found on this machine. ';
  if (!tabs) return foundText.trim();
  const open = [
    ...(['claude', 'opencode', 'copilot'] as const)
      .filter((id) => tabs[id])
      .map((id) => AGENT_LABELS[id]),
    ...(tabs.shell ? ['a shell'] : []),
  ];
  return `${foundText}New tasks open ${open.length ? list(open) : 'no tabs'}.`;
}

/** Opens a step's page; Add folder… asks for the folder first. */
function useStepActions() {
  const go = useStore((s) => s.go);
  const notify = useStore((s) => s.notify);
  return {
    agents: () => go({ kind: 'agents', from: 'get-started' }),
    connect: () => go({ kind: 'connect', from: 'get-started' }),
    repository: async () => {
      const folder = await tryInvoke(
        () => api().invoke('repos:pickFolder'),
        notify,
      );
      if (folder) go({ kind: 'add-repo', from: 'get-started', folder });
    },
  } satisfies Record<OnboardingStep, () => void>;
}

const TITLES: Record<OnboardingStep, string> = {
  agents: '1 · Agents',
  connect: '2 · Connect your tracker',
  repository: '3 · Add a repository',
};
const BUTTONS: Record<OnboardingStep, string> = {
  agents: 'Open',
  connect: 'Connect',
  repository: 'Add folder…',
};

/** The step cards: all three on the page, the unfinished ones (compact) in the Home band. */
export function StepCards({ band }: { band?: boolean }) {
  const settings = useStore((s) => s.settings);
  const connections = useStore((s) => s.connections);
  const repos = useStore((s) => s.repos);
  const steps = stepsFrom({ settings, connections, repos });
  const actions = useStepActions();
  const [detected, setDetected] = useState<AgentsDetected | null>(null);
  const agentsDone = steps.agents === 'done';

  // The cached detection, also before Agents is done: card 1 then names what was found and the tabs it will tick.
  useEffect(() => {
    if (band) return;
    let live = true;
    api()
      .invoke('agents:detect', false)
      .then((d) => {
        if (live) setDetected(d);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [band]);

  const text: Record<OnboardingStep, React.ReactNode> = {
    agents: agentsDone
      ? agentsLine(detected, settings?.defaultTerminals)
      : detected
        ? agentsLine(detected, pretick(detected))
        : 'See which agent CLIs are installed and pick the tabs a new task opens.',
    connect:
      steps.connect === 'done' && connections.length
        ? `Connected to ${list(connections.map((c) => `${c.name}/${c.project}`))}.`
        : steps.connect === 'done'
          ? 'No tracker: tasks start blank, on a branch.'
          : 'Azure DevOps now; GitHub later. Shellie reads your sprint and writes cost, time and draft pull requests back.',
    repository: repos.length ? (
      `Added ${list(repos.map((r) => r.name))}.`
    ) : (
      <>
        Pick a folder. Shellie reads its remote and stack and proposes a{' '}
        <code className="chip-code">.shellie.yml</code>.
      </>
    ),
  };

  const keys = (['agents', 'connect', 'repository'] as const).filter(
    (k) => !band || steps[k] === 'todo',
  );
  return (
    <div className={band ? 'step-cards in-band' : 'step-cards'}>
      {keys.map((k) => {
        const current = steps.current === k;
        const done = steps[k] === 'done';
        return (
          <section
            key={k}
            aria-label={TITLES[k]}
            className={current ? 'step-card is-current' : 'step-card'}
          >
            {done ? (
              <span className="step-mark is-done" aria-label="Done">
                ✓
              </span>
            ) : (
              <span
                className={current ? 'step-mark is-current' : 'step-mark'}
                aria-hidden="true"
              >
                {(['agents', 'connect', 'repository'] as const).indexOf(k) + 1}
              </span>
            )}
            <div className="step-card-body">
              <h3>{TITLES[k]}</h3>
              {!band && <p className="small muted">{text[k]}</p>}
            </div>
            <button
              type="button"
              className={current ? 'btn btn-primary' : 'btn'}
              onClick={() => void actions[k]()}
            >
              {k === 'agents' && agentsDone ? 'Change' : BUTTONS[k]}
            </button>
          </section>
        );
      })}
    </div>
  );
}

/** Saves `dismissedAt`: the page stops opening at start and the Home band goes. */
export async function dismissOnboarding(
  notify: (level: 'error', message: string) => void,
): Promise<boolean> {
  const { repos, connections } = useStore.getState();
  const saved = await tryInvoke(
    () =>
      saveSettings((f) => ({
        onboarding: { ...f.onboarding, dismissedAt: new Date().toISOString() },
      })),
    notify,
  );
  if (!saved) return false;
  track('onboarding.dismissed', {
    repos: repos.length,
    connections: connections.length,
  });
  return true;
}

function Art() {
  const [failed, setFailed] = useState(false);
  return (
    <div className="get-started-art">
      {ART && !failed ? (
        <img src={ART} alt="" onError={() => setFailed(true)} />
      ) : (
        <MindMark size={64} />
      )}
    </div>
  );
}

/** First run: what a task is and the three setup steps. */
export function GetStartedScreen() {
  const go = useStore((s) => s.go);
  const notify = useStore((s) => s.notify);

  useEffect(() => track('onboarding.shown'), []);

  const skip = async () => {
    if (await dismissOnboarding(notify)) go({ kind: 'home' });
  };

  return (
    <div className="page">
      <div className="page-body get-started">
        <div className="get-started-main">
          <h1>Welcome to Shellie</h1>
          <p className="muted">
            A task is a git worktree with its own agent tabs, tied to a work
            item, with the AI cost and time it took. Three short steps and your
            sprint is on this page.
          </p>
          <StepCards />
          <p className="small muted">
            Nothing here is required. Skip to Home and Shellie works with a
            shell alone; every step is in Settings later.{' '}
            <button type="button" className="link" onClick={() => void skip()}>
              Skip for now
            </button>
          </p>
        </div>
        <aside className="get-started-side">
          <Art />
          <div className="card get-started-gets">
            <h3>What you get</h3>
            <ul>
              <li>
                Start on a sprint item → worktree, branch, setup, agent tabs
              </li>
              <li>Claude Code and Copilot cost per task, priced in EUR</li>
              <li>Time, changes review, Docs, draft PR at Finish</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
