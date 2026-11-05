import { useState } from 'react';
import type { TerminalDef } from '../../shared/types';
import { brainTaskId } from '../../shared/brain';
import { api, tryInvoke } from '../api';
import { AskBox } from '../components/brain/AskBox';
import { BrainFiles } from '../components/brain/BrainFiles';
import { BrainWiki } from '../components/brain/BrainWiki';
import { BrainHealth } from '../components/brain/BrainHealth';
import { BrainInbox } from '../components/brain/BrainInbox';
import { BrainLog } from '../components/brain/BrainLog';
import {
  openBrainTerminal,
  trackBrain,
} from '../components/brain/brainActions';
import { PageHeader, Pivots } from '../components/ui';
import { TerminalView } from '../components/TerminalView';
import { useBrain } from '../hooks/useBrains';
import { useStore } from '../store';

type Tab = 'sources' | 'wiki' | 'log';
const TABS: { key: Tab; label: string }[] = [
  { key: 'sources', label: 'Sources' },
  { key: 'wiki', label: 'Wiki' },
  { key: 'log', label: 'Log' },
];

/** One brain: its inbox and health, its files and log, and its terminal. */
export function BrainScreen({
  brainId,
  focus,
}: {
  brainId: string;
  focus?: 'ask' | 'wiki' | 'drop';
}) {
  const brain = useBrain(brainId);
  const notify = useStore((s) => s.notify);
  const [tab, setTab] = useState<Tab>(focus === 'wiki' ? 'wiki' : 'sources');
  const [terminal, setTerminal] = useState<TerminalDef | null>(null);

  if (!brain)
    return (
      <div className="page">
        <PageHeader title="Brain" />
        <div className="page-body">
          <p className="muted">Loading</p>
        </div>
      </div>
    );

  const run = (kind: 'lint' | 'digest') => {
    trackBrain(kind);
    void tryInvoke(() => api().invoke('brain:run', brain.id, kind), notify);
  };
  const refresh = async () => {
    trackBrain('refresh');
    const r = await tryInvoke(
      () => api().invoke('brain:refresh', brain.id),
      notify,
    );
    if (!r) return;
    if (r.ok)
      notify(
        'info',
        `Wiki refreshed: ${r.added} added, ${r.changed} changed, ${r.removed} removed`,
      );
    else notify('error', r.message);
  };
  const openTerminal = async () => {
    trackBrain('terminal');
    const def = await openBrainTerminal(brain.id, notify);
    if (def) setTerminal(def);
  };
  const closeTerminal = async (id: string) => {
    trackBrain('close-terminal');
    setTerminal(null);
    await tryInvoke(() => api().invoke('terminals:kill', id), notify);
  };

  return (
    <div className="page brain-page">
      <PageHeader
        title={brain.name}
        after={<span className="muted">{brain.project}</span>}
        inline
        commands={
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void refresh()}
            >
              Refresh wiki
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => run('lint')}
            >
              Lint
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => run('digest')}
            >
              Digest
            </button>
            <AskBox
              brainId={brain.id}
              onTerminal={setTerminal}
              initiallyOpen={focus === 'ask'}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void openTerminal()}
            >
              Open terminal
            </button>
          </>
        }
      />
      <div className="page-body brain-body">
        <div className="brain-columns">
          <BrainInbox
            brain={brain}
            onTerminal={setTerminal}
            focusChoose={focus === 'drop'}
          />
          <BrainHealth brain={brain} onTerminal={setTerminal} />
        </div>
        <Pivots
          label="Brain files"
          items={TABS}
          selected={tab}
          onSelect={setTab}
        />
        {tab === 'sources' && <BrainFiles brainId={brain.id} dir="sources" />}
        {tab === 'wiki' && <BrainWiki brainId={brain.id} />}
        {tab === 'log' && <BrainLog brainId={brain.id} />}
        {terminal && (
          <div className="brain-terminal">
            <div className="brain-terminal-bar">
              <span className="small muted">{terminal.label}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void closeTerminal(terminal.id)}
              >
                Close
              </button>
            </div>
            <TerminalView
              key={terminal.id}
              terminalId={terminal.id}
              taskId={brainTaskId(brain.id)}
              active
              resumes
              autoStart
            />
          </div>
        )}
      </div>
    </div>
  );
}
