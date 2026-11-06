import { ChevronDown16Regular, Send16Regular } from '@fluentui/react-icons';
import { useCallback, useRef, useState } from 'react';
import { isAgentKind } from '../../../shared/agents';
import type { ReviewComment, ReviewState } from '../../../shared/review';
import type { TaskView } from '../../../shared/types';
import { api, tryInvoke } from '../../api';
import { readSendTarget } from '../../docs/docsPrefs';
import {
  pasteToTerminal,
  pickSendTarget,
  showTerminal,
} from '../../docs/sendToTerminal';
import { buildReviewPrompt } from '../../review/reviewPrompt';
import { useStore } from '../../store';
import { track } from '../../telemetry';
import { PopupMenu } from '../ui';
import { plural } from '../../format';

export function SendComments({
  task,
  comments,
  repoName,
  multiRepo,
  onSent,
}: {
  task: TaskView;
  comments: ReviewComment[];
  repoName: (workspaceId: string) => string;
  multiRepo: boolean;
  onSent: (s: ReviewState) => void;
}) {
  const notify = useStore((s) => s.notify);
  const [menu, setMenu] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [chosen, setChosen] = useState<string | null>(() =>
    readSendTarget(task.id),
  );
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const close = useCallback(() => setMenu(false), []);
  // Agent tabs only: a shell would run each line of the paste.
  const targets = task.terminals.filter((t) => isAgentKind(t.kind));
  const open = comments.filter((c) => c.status === 'open');
  const target = pickSendTarget(targets, chosen, (t) => t.kind === 'claude');

  const send = async (id: string) => {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    try {
      await sendNow(id);
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  const sendNow = async (id: string) => {
    setMenu(false);
    const t = targets.find((x) => x.id === id);
    if (!t || open.length === 0) return;
    const inRepo = (c: ReviewComment, p: string) =>
      multiRepo ? `${repoName(c.workspaceId)}/${p}` : p;
    const items = open.map((c) => ({
      path: inRepo(c, c.path),
      ...(c.oldPath ? { oldPath: inRepo(c, c.oldPath) } : {}),
      side: c.side,
      startLine: c.startLine,
      endLine: c.endLine,
      snippet: c.snippet,
      text: c.text,
    }));
    const pasted = await pasteToTerminal({
      taskId: task.id,
      id,
      who: t.label,
      text: (bracketed) => buildReviewPrompt(items, { singleLine: !bracketed }),
      notify,
      onChosen: setChosen,
    });
    if (!pasted) return;
    const s = await tryInvoke(
      () =>
        api().invoke(
          'review:markSent',
          task.id,
          open.map((c) => c.id),
        ),
      notify,
    );
    if (s) {
      onSent(s);
      track('review.commentsSent', { count: open.length });
    }
    showTerminal(task.id, id);
  };

  // Nothing to send: no button at all, the header stays short.
  if (open.length === 0) return null;
  const n = plural(open.length, 'comment');
  if (!target)
    return (
      <button
        type="button"
        className="btn btn-sm"
        disabled
        title="Open a Claude Code tab first"
      >
        <Send16Regular aria-hidden="true" />
        {`Send ${n}`}
      </button>
    );
  return (
    <span className="split-btn">
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={sending}
        onClick={() => void send(target.id)}
      >
        <Send16Regular aria-hidden="true" />
        {`Send ${n} to ${target.label}`}
      </button>
      {targets.length > 1 && (
        <button
          ref={setAnchor}
          type="button"
          className="btn btn-primary btn-sm"
          aria-label="Choose terminal"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <ChevronDown16Regular aria-hidden="true" />
        </button>
      )}
      <PopupMenu label="Send to" anchor={anchor} open={menu} onClose={close}>
        {targets.map((t) => (
          <button
            key={t.id}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => void send(t.id)}
          >
            <span className="menu-title">{t.label}</span>
          </button>
        ))}
      </PopupMenu>
    </span>
  );
}
