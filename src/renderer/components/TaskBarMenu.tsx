import { MoreHorizontal16Regular } from '@fluentui/react-icons';
import { Fragment, useCallback, useState } from 'react';
import { useContributed } from '../commands/registry';
import { shortcutLabel } from '../commands/shortcut';
import type { Command } from '../commands/types';
import { useStore } from '../store';
import { modKey, PopupMenu } from './ui';

/**
 * The task menu's sections, by command id: the views, the ways out to an editor, what changes the task's setup,
 * and the ways out of the task. An id ending in a dot stands for every command that starts with it.
 */
const SECTIONS: string[][] = [
  ['task.changes', 'task.usage', 'task.docs', 'task.brain'],
  ['task.editor', 'task.editor.', 'task.folder', 'app.focus'],
  ['task.environment', 'task.cleanWorktree', 'task.scan', 'task.addWorktree'],
  ['task.finish', 'task.discard'],
];

const FOCUS_SHORTCUT = { code: 'KeyF', shift: true };

/**
 * The "..." at the right of the task bar: where the task is (branch, git state, environment), then everything the
 * bar used to show as buttons. Its items are the commands the task's components offer (`useContributeCommands`), so
 * the menu, the palette and the shortcuts cannot drift apart.
 */
export function TaskBarMenu({
  where,
  dots = {},
}: {
  /** The lines of the block at the top: branch, git state, environment. */
  where: string[];
  /** Command ids that carry a "new" dot: a view with something unseen whose tab is closed. */
  dots?: Record<string, boolean>;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="ibtn"
        aria-label="Task menu"
        title="Task menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal16Regular aria-hidden="true" />
      </button>
      <PopupMenu label="Task menu" anchor={anchor} open={open} onClose={close}>
        {open && <Items where={where} dots={dots} close={close} />}
      </PopupMenu>
    </>
  );
}

/** The menu's content, mounted only while it is open. */
function Items({
  where,
  dots,
  close,
}: {
  where: string[];
  dots: Record<string, boolean>;
  close: () => void;
}) {
  const offered = useContributed();
  const toggleFocus = useStore((s) => s.toggleFocus);
  const focus: Command = {
    id: 'app.focus',
    title: 'Focus mode',
    group: 'app',
    shortcut: FOCUS_SHORTCUT,
    run: toggleFocus,
  };
  const all = [...offered, focus];
  const sections = SECTIONS.map((ids) =>
    ids.flatMap((id) =>
      all.filter((c) => (id.endsWith('.') ? c.id.startsWith(id) : c.id === id)),
    ),
  ).filter((s) => s.length > 0);
  return (
    <>
      <div className="taskmenu-where mono small muted">
        {where.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
      {sections.map((commands) => (
        <Fragment key={commands[0].id}>
          <div className="menu-sep" role="separator" />
          {commands.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              className="menu-item taskmenu-item"
              onClick={() => {
                close();
                c.run();
              }}
            >
              <span className="taskmenu-title">
                {c.title}
                {dots[c.id] && <span className="tab-new" aria-hidden="true" />}
              </span>
              {(c.note || c.shortcut) && (
                <span className="small muted">
                  {c.note ?? (c.shortcut && shortcutLabel(c.shortcut, modKey))}
                </span>
              )}
            </button>
          ))}
        </Fragment>
      ))}
    </>
  );
}
