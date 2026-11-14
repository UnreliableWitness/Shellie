import { useEffect } from 'react';
import { api } from './api';
import { HeaderBar } from './components/HeaderBar';
import { Notices } from './components/Notices';
import { TaskNav } from './components/TaskNav';
import { invalidateRepoConfig } from './hooks/useRepoConfig';
import { useAttention } from './hooks/useAttention';
import { useTimeFocus } from './hooks/useTimeFocus';
import { useShortcuts } from './hooks/useShortcuts';
import { AddRepoScreen } from './screens/AddRepoScreen';
import { AgentsScreen } from './screens/AgentsScreen';
import { BrainNewScreen } from './screens/BrainNewScreen';
import { BrainJoinScreen } from './screens/BrainJoinScreen';
import { BrainScreen } from './screens/BrainScreen';
import { useReadingFeed } from './hooks/useReadingFeed';
import { ConnectScreen } from './screens/ConnectScreen';
import { FinishScreen } from './screens/FinishScreen';
import { GetStartedScreen } from './screens/GetStartedScreen';
import { NewTaskScreen } from './screens/NewTaskScreen';
import { SecretsImportScreen } from './screens/SecretsImportScreen';
import { SecretsScreen } from './screens/SecretsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { HomeScreen } from './screens/HomeScreen';
import { ProjectScreen } from './screens/ProjectScreen';
import { SetupScreen } from './screens/SetupScreen';
import { SprintScreen } from './screens/SprintScreen';
import { TaskScreen, TaskTerminals } from './screens/TaskScreen';
import { useStore } from './store';
import { useWorkItemTypes } from './workItemTypes';

function Page() {
  const screen = useStore((s) => s.screen);
  switch (screen.kind) {
    case 'home':
      return <HomeScreen />;
    case 'brain-new':
      return <BrainNewScreen />;
    case 'get-started':
      return <GetStartedScreen />;
    case 'agents':
      return <AgentsScreen />;
    case 'sprint':
      return <SprintScreen />;
    case 'project':
      return <ProjectScreen />;
    case 'brain':
      return (
        <BrainScreen
          key={`${screen.brainId}:${screen.focus ?? ''}`}
          brainId={screen.brainId}
          focus={screen.focus}
          open={screen.open}
        />
      );
    case 'brain-join':
      return (
        <BrainJoinScreen
          key={screen.link}
          link={screen.link}
          via={screen.via ?? 'link'}
        />
      );
    case 'task':
      return <TaskScreen />;
    case 'new-task':
      return (
        <NewTaskScreen
          key={`${screen.connectionId ?? ''}:${screen.repoId ?? ''}:${screen.workItem?.id ?? ''}`}
          initial={screen}
        />
      );
    case 'setup':
      return <SetupScreen taskId={screen.taskId} />;
    case 'finish':
      return <FinishScreen key={screen.taskId} taskId={screen.taskId} />;
    case 'add-repo':
      return <AddRepoScreen key={screen.folder ?? ''} folder={screen.folder} />;
    case 'connect':
      return <ConnectScreen key={screen.connectionId ?? ''} />;
    case 'settings':
      return <SettingsScreen />;
    case 'secrets':
      return <SecretsScreen key={screen.repoId ?? ''} repoId={screen.repoId} />;
    case 'secrets-import':
      return <SecretsImportScreen key={screen.repoId} repoId={screen.repoId} />;
  }
}

/** Header, nav and the current page. Focus hides the header and nav for a ready task. */
export function Shell() {
  const inFocus = useStore(
    (s) =>
      s.focus &&
      s.screen.kind === 'task' &&
      s.tasks.find((t) => t.id === s.selectedTaskId)?.status === 'ready',
  );
  const navCollapsed = useStore((s) => s.navCollapsed);
  useShortcuts();
  return (
    // In focus the task's tab row is the top bar, so it takes over as the title bar (shell.css).
    <div className={inFocus ? 'app in-focus' : 'app'}>
      {!inFocus && <HeaderBar />}
      <div className="shell">
        {(!inFocus || navCollapsed) && <TaskNav />}
        <main className="content">
          <Page />
          <TaskTerminals />
        </main>
      </div>
      <Notices />
    </div>
  );
}

export function App() {
  const load = useStore((s) => s.load);
  const setTasks = useStore((s) => s.setTasks);
  const setRepos = useStore((s) => s.setRepos);
  const setConnections = useStore((s) => s.setConnections);
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  useTimeFocus();
  useAttention();
  useReadingFeed();

  useEffect(() => {
    void load().catch((e: Error) => notify('error', e.message));
    const offs = [
      api().on('tasks:changed', setTasks),
      api().on('repos:changed', (repos) => {
        invalidateRepoConfig();
        setRepos(repos);
      }),
      api().on('connections:changed', (connections) => {
        useWorkItemTypes.getState().prune(connections.map((c) => c.id));
        setConnections(connections);
      }),
      api().on('notice', (n) => notify(n.level, n.message)),
    ];
    return () => offs.forEach((off) => off());
  }, [load, setTasks, setRepos, setConnections, notify]);

  // A shellie://join link: live from main, or the one that arrived before this window listened (a cold start).
  useEffect(() => {
    const off = api().on('brain:openJoin', ({ link }) =>
      go({ kind: 'brain-join', link }),
    );
    api()
      .invoke('brain:pendingJoin')
      .then(
        (link) => link && go({ kind: 'brain-join', link }),
        () => undefined,
      );
    return off;
  }, [go]);

  return <Shell />;
}
