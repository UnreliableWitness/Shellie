import { ChevronDown12Regular } from '@fluentui/react-icons';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { AGENT_IDS, AGENT_LABELS, type AgentId } from '../../shared/agents';
import type { DefaultTerminals } from '../../shared/terminals';
import { api } from '../api';
import { PopupMenu } from './ui';

/**
 * A Start button with a chevron next to it: a menu of the installed agents, the ones ticked in Settings marked as the
 * default; picking one starts the task with that agent (#313). Clicks stay inside, so a sprint row does not open
 * its work item.
 */
export function StartAgentMenu({
  label,
  className,
  disabled,
  verb = 'Start',
  markDefaults = true,
  onPick,
  children,
}: {
  /** The work item's label, for the button's name. */
  label: string;
  className: string;
  disabled?: boolean;
  /** What the main button does, for the chevron's hint and the menu's name: Start, or Reopen. */
  verb?: string;
  /** Marks the agents ticked in Settings as "(default)": what the main button starts. Off where it does not. */
  markDefaults?: boolean;
  onPick: (agent: AgentId) => void;
  /** The Start button. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [found, setFound] = useState<AgentId[] | null>(null);
  const [defaults, setDefaults] = useState<DefaultTerminals | null>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void Promise.all([
      api().invoke('agents:detect', false),
      api().invoke('settings:get'),
    ])
      .then(([detected, settings]) => {
        if (!live) return;
        setFound(AGENT_IDS.filter((id) => detected.agents[id].found));
        setDefaults(settings.defaultTerminals);
      })
      .catch(() => {
        // Without detection every agent shows; a missing one fails in its tab.
        if (live) setFound([]);
      });
    return () => {
      live = false;
    };
  }, [open]);

  // Nothing detected is no reason to hide the choice: every agent then shows.
  const agents = found?.length ? found : AGENT_IDS;
  return (
    <span className="split-btn" onClick={(e) => e.stopPropagation()}>
      {children}
      <button
        ref={setAnchor}
        type="button"
        className={className}
        aria-label={`Choose the agent for ${label}`}
        title={`${verb} with another agent`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <ChevronDown12Regular aria-hidden="true" />
      </button>
      <PopupMenu
        label={`${verb} with`}
        anchor={anchor}
        open={open}
        onClose={close}
      >
        {found !== null &&
          agents.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              className="menu-item"
              aria-label={AGENT_LABELS[id]}
              onClick={() => {
                setOpen(false);
                onPick(id);
              }}
            >
              <span className="menu-title">
                {markDefaults && defaults?.[id]
                  ? `${AGENT_LABELS[id]} (default)`
                  : AGENT_LABELS[id]}
              </span>
            </button>
          ))}
      </PopupMenu>
    </span>
  );
}
