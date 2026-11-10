import {
  Add16Regular,
  ArrowUpload24Regular,
  Dismiss16Regular,
} from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import type { BrainView, SourceType } from '../../../../shared/brain';
import { local } from '../../../localStorage';
import { trackBrain } from '../brainActions';
import { STEPS } from '../HowItWorks';
import { AddedNotes } from '../PendingFiles';
import { SOURCE_TYPES } from '../useBrainDrop';
import { FileChip } from './FileChip';
import { MarkdownEditor, type EditorView } from './MarkdownEditor';
import { ModelPicker } from './ModelPicker';
import { suggestStronger } from './text';
import type { ComposerState } from './useComposer';

export const NOTE_HINT =
  'Goes with the text and every file. What is this, what matters, what is outdated?';
export const FORMATS =
  'PDF, Word, PowerPoint, Excel, draw.io, VTT, Markdown, text, pictures';
const PLACEHOLDER =
  'Write or paste here. Markdown works: # heading, - list, [link](url), tables.\nPaste an email, a Teams thread or a web page and it turns into Markdown.\nDrop files anywhere on this page.';

const VIEW_KEY = 'shellie.brain.editorView';
/** Discard asks first above this many words of text, or with a file attached. */
const ASK_WORDS = 20;

const readView = (): EditorView => {
  try {
    const v = local()?.getItem(VIEW_KEY);
    if (v === 'write' || v === 'split' || v === 'preview') return v;
  } catch {
    // A convenience only.
  }
  return typeof window !== 'undefined' && window.innerWidth >= 1200
    ? 'split'
    : 'write';
};

/** Add, Add text, Add 2 files, Add text and 1 file. */
export function addLabel(text: boolean, files: number): string {
  const f = files === 1 ? '1 file' : `${files} files`;
  if (text && files) return `Add text and ${f}`;
  if (text) return 'Add text';
  if (files) return `Add ${f}`;
  return 'Add';
}

/** Added Steerco and 2 files. / Added 2 files. / Added Steerco. */
function addedLine(title: string | null, files: number): string {
  const f = files === 1 ? '1 file' : `${files} files`;
  const what =
    title !== null
      ? files
        ? `${title || 'the text'} and ${f}`
        : title || 'the text'
      : f;
  return `Added ${what}. Capturing now; you can keep adding.`;
}

/**
 * The Add view's composer: a title, a Markdown editor, the attached files, one note, Capture with and one Add.
 * After a successful add it folds to one line until it is used again.
 */
export function Composer({
  brain,
  composer: c,
  expanded,
  onExpand,
  onAdded,
  dropping,
  focusAttach = false,
}: {
  brain: BrainView;
  composer: ComposerState;
  expanded: boolean;
  onExpand(): void;
  /** Everything went in: the view folds the composer. */
  onAdded(): void;
  /** Files are being dragged over the view: how many, when the browser says. */
  dropping: { count: number } | null;
  /** Put the cursor on Attach files once mounted (a deep link to adding files). */
  focusAttach?: boolean;
}) {
  const { draft } = c;
  const [view, setView] = useState<EditorView>(readView);
  const [asking, setAsking] = useState(false);
  const [howto, setHowto] = useState(false);
  const attachRef = useRef<HTMLLabelElement>(null);
  useEffect(() => {
    if (focusAttach) attachRef.current?.focus();
  }, [focusAttach]);

  const hasText = draft.text.trim() !== '';
  const busy = c.adding;
  const nothing = !hasText && draft.files.length === 0;
  const opencode = brain.options.agent === 'opencode';
  const stronger = suggestStronger(
    draft.files.map((f) => ({ name: f.name, bytes: f.bytes })),
  );
  const hint =
    !opencode &&
    stronger &&
    draft.model !== 'opus' &&
    brain.options.model !== 'opus';

  const changeView = (v: EditorView) => {
    setView(v);
    trackBrain('editor-view');
    try {
      local()?.setItem(VIEW_KEY, v);
    } catch {
      // A convenience only.
    }
  };
  const add = async () => {
    if (nothing || busy) return;
    if (await c.add()) onAdded();
  };
  const discard = () => {
    const words = draft.text.trim().split(/\s+/).filter(Boolean).length;
    if (!asking && (words > ASK_WORDS || draft.files.length > 0)) {
      setAsking(true);
      return;
    }
    setAsking(false);
    c.discard();
  };

  const attach = (
    <label className="btn btn-sm brain-attach" ref={attachRef} tabIndex={-1}>
      <Add16Regular />
      Attach files
      <input
        type="file"
        multiple
        hidden
        aria-label="Attach files"
        onChange={(e) => {
          void c.addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </label>
  );

  const feedback = (
    <>
      {c.added && (
        <div className="brain-added" role="status">
          <span className="grow">
            {addedLine(c.added.title, c.added.files)}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Dismiss"
            onClick={c.dismissAdded}
          >
            <Dismiss16Regular />
          </button>
        </div>
      )}
      {c.added && (
        <AddedNotes
          brainId={brain.id}
          added={c.added.sources}
          jobs={brain.jobs}
        />
      )}
    </>
  );

  if (!expanded)
    return (
      <>
        {feedback}
        <section
          className="brain-card brain-composer is-folded"
          aria-label={`Add to ${brain.name}`}
        >
          <h2 className="brain-composer-h">Add to {brain.name}</h2>
          <input
            className="field grow"
            aria-label="Write or paste"
            placeholder="Write or paste, or drop files…"
            value=""
            onFocus={onExpand}
            onChange={(e) => {
              c.setText(e.target.value);
              onExpand();
            }}
          />
          {attach}
        </section>
      </>
    );

  return (
    <>
      {feedback}
      <section
        className="brain-card brain-composer"
        aria-labelledby="brain-composer-h"
      >
        <div className="brain-composer-head">
          <h2 id="brain-composer-h" className="brain-composer-h">
            Add to {brain.name}
          </h2>
          <span className="grow" />
          {!c.isEmpty && (
            <span className="muted small">
              Draft kept while you switch views
            </span>
          )}
          <button
            type="button"
            className="brain-help"
            aria-label="How adding works"
            aria-expanded={howto}
            onClick={() => {
              if (!howto) trackBrain('help');
              setHowto(!howto);
            }}
          >
            ?
          </button>
          {howto && (
            <ol className="brain-howto-pop" aria-label="How adding works">
              {STEPS.map((s) => (
                <li key={s.title}>
                  <strong>{s.title}</strong>
                  <span className="muted small">{s.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <input
          className="brain-composer-title"
          aria-label="Title"
          placeholder="Title (optional, made from the first heading)"
          value={draft.title}
          disabled={busy}
          onChange={(e) => c.setTitle(e.target.value)}
        />
        <MarkdownEditor
          value={draft.text}
          onChange={c.setText}
          onSubmit={() => void add()}
          placeholder={PLACEHOLDER}
          view={view}
          onView={changeView}
          label="Text"
        />
        <div className="brain-chips">
          {draft.files.map((f) => (
            <FileChip
              key={f.path}
              file={f}
              disabled={busy}
              onType={(type) => c.setFile(f.path, { type })}
              onOwnNote={(ownNote) => c.setFile(f.path, { ownNote })}
              onRemove={() => c.removeFile(f.path)}
            />
          ))}
          {attach}
        </div>
        <label className="brain-composer-note">
          <span className="brain-composer-note-label">
            <strong>Note for the agent</strong>
            <span className="muted small">{NOTE_HINT}</span>
          </span>
          <textarea
            className="field"
            aria-label="Note for the agent"
            rows={2}
            placeholder="What is this? What matters, what is outdated?"
            value={draft.note}
            disabled={busy}
            onChange={(e) => c.setNote(e.target.value)}
          />
        </label>
        {c.problems.length > 0 && (
          <ul className="brain-problems small" role="alert">
            {c.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
        <div className="brain-composer-foot">
          {hasText && (
            <label className="brain-composer-pick">
              <span>Text goes in as</span>
              <select
                className="field brain-pill"
                aria-label="Text goes in as"
                value={draft.textType}
                disabled={busy}
                onChange={(e) => c.setTextType(e.target.value as SourceType)}
              >
                {SOURCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ModelPicker
            brain={brain}
            value={draft.model}
            onChange={c.setModel}
            disabled={busy}
          />
          {hint && (
            <span className="muted small">
              Opus may capture {stronger} better
            </span>
          )}
          <span className="grow" />
          {asking ? (
            <span className="brain-composer-ask small">
              <span>Discard this draft?</span>
              <button type="button" className="btn btn-sm" onClick={discard}>
                Discard draft
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setAsking(false)}
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy || c.isEmpty}
              onClick={discard}
            >
              Discard
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={nothing || busy}
            onClick={() => void add()}
          >
            {busy ? 'Adding…' : addLabel(hasText, draft.files.length)}
          </button>
        </div>
        {dropping && (
          <div className="brain-drop-over" role="status">
            <ArrowUpload24Regular />
            <strong>
              {dropping.count > 0
                ? `Drop to add ${dropping.count === 1 ? '1 file' : `${dropping.count} files`}`
                : 'Drop to add files'}
            </strong>
            <span className="small">
              Markdown and text open in the editor; other files are attached as
              they are.
            </span>
            <span className="muted small">{FORMATS}</span>
          </div>
        )}
      </section>
    </>
  );
}
