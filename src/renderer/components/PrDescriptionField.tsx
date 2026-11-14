import { prDraftBusy, type PrDraft } from '../../shared/prDraft';

const ELLIPSIS = String.fromCharCode(0x2026);

/** What the head of the field says while the draft is being written. */
function writingLine(draft: PrDraft): string {
  if (draft.status === 'asking-tab')
    return `Asking ${draft.tab?.label ?? 'the agent tab'}${ELLIPSIS}`;
  if (draft.status === 'tab-blocked')
    return `${draft.tab?.label ?? 'The agent tab'} is waiting for you`;
  return draft.source === 'headless' && draft.note
    ? `Writing it without the agent tab${ELLIPSIS}`
    : `Writing it${ELLIPSIS}`;
}

/**
 * A PR's "what changed and why" on the Finish page (#111): asked of the task's agent tab or written in the
 * background, edited by the user.
 */
export function PrDescriptionField({
  draft,
  onChange,
  onRewrite,
  onSkip,
  onShowTab,
}: {
  draft: PrDraft;
  onChange: (text: string) => void;
  onRewrite: () => void;
  onSkip: () => void;
  onShowTab?: (tabId: string) => void;
}) {
  const writing = prDraftBusy(draft);
  const tab = draft.tab;
  const asking =
    draft.status === 'asking-tab' || draft.status === 'tab-blocked';
  return (
    <div className="pr-summary">
      <div className="pr-summary-head">
        <span className="small">What changed and why</span>
        {writing ? (
          <>
            <span className="muted small">{writingLine(draft)}</span>
            {asking && tab && onShowTab && (
              <button
                type="button"
                className="btn btn-subtle btn-sm"
                onClick={() => onShowTab(tab.id)}
              >
                Show tab
              </button>
            )}
            <button
              type="button"
              className="btn btn-subtle btn-sm"
              onClick={onSkip}
            >
              Skip
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-subtle btn-sm"
            onClick={onRewrite}
          >
            Write again
          </button>
        )}
      </div>
      <textarea
        className="field"
        aria-label="Pull request description"
        rows={9}
        value={draft.text}
        disabled={writing}
        placeholder="The PR description starts with this text (Markdown). Leave it empty for the commit list only."
        onChange={(e) => onChange(e.target.value)}
      />
      {draft.status === 'failed' && (
        <div className="muted small">{`Not written: ${draft.error ?? 'unknown error'}. Type one here, or leave it empty for the commit list only.`}</div>
      )}
      {draft.status === 'ready' && draft.source === 'tab' && tab && (
        <div className="muted small">{`Written by ${tab.label} from this task's session.`}</div>
      )}
      {draft.status === 'ready' && draft.note && (
        <div className="muted small">{draft.note}</div>
      )}
      <div className="muted small">The commit list follows it.</div>
    </div>
  );
}
