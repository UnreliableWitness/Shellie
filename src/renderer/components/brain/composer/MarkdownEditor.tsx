import type * as Monaco from 'monaco-editor';
import {
  Code16Regular,
  Link16Regular,
  Table16Regular,
  TaskListSquareLtr16Regular,
  TextBold16Regular,
  TextBulletList16Regular,
  TextItalic16Regular,
} from '@fluentui/react-icons';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  currentColorScheme,
  monacoTheme,
  useColorScheme,
} from '../../../colorScheme';
import { loadMonaco } from '../../../review/loadMonaco';
import { MarkdownView } from '../../docs/MarkdownView';
import { trackBrain } from '../brainActions';
import { htmlToMarkdown, isRichHtml } from './htmlToMarkdown';
import { applyFormat, type Format } from './text';

export type EditorView = 'write' | 'split' | 'preview';

const VIEWS: { id: EditorView; label: string }[] = [
  { id: 'write', label: 'Write' },
  { id: 'split', label: 'Split' },
  { id: 'preview', label: 'Preview' },
];

const BUTTONS: { format: Format; label: string; icon: ReactNode }[] = [
  { format: 'heading', label: 'Heading', icon: <b aria-hidden="true">H</b> },
  { format: 'bold', label: 'Bold', icon: <TextBold16Regular /> },
  { format: 'italic', label: 'Italic', icon: <TextItalic16Regular /> },
  {
    format: 'bullets',
    label: 'Bulleted list',
    icon: <TextBulletList16Regular />,
  },
  {
    format: 'checklist',
    label: 'Checklist',
    icon: <TaskListSquareLtr16Regular />,
  },
  { format: 'link', label: 'Link', icon: <Link16Regular /> },
  { format: 'code', label: 'Code', icon: <Code16Regular /> },
  { format: 'table', label: 'Table', icon: <Table16Regular /> },
];

/** How long "Pasted as Markdown · Paste as plain text" stays. */
const PASTED_MS = 10_000;

/** Reads and writes the text and its selection, as offsets, on Monaco or the plain text box. */
type Surface = {
  selection(): [number, number];
  /** Replaces start..end with `text` (one undo step) and selects selStart..selEnd. */
  replace(
    start: number,
    end: number,
    text: string,
    selStart: number,
    selEnd: number,
  ): void;
};

const noAsset = () => Promise.reject(new Error('no pictures in a draft'));
const noop = () => undefined;

/**
 * The composer's Markdown editor: Monaco once it has loaded (a plain text box until then, and for good when it
 * cannot load), a formatting toolbar, Write / Split / Preview, Ctrl or Cmd+Enter to submit, and rich text pasted as
 * Markdown with a way back to the plain text.
 */
export function MarkdownEditor({
  value,
  onChange,
  onSubmit,
  placeholder,
  view,
  onView,
  label,
  autoFocus = false,
}: {
  value: string;
  onChange(v: string): void;
  onSubmit(): void;
  placeholder: string;
  view: EditorView;
  onView(v: EditorView): void;
  label: string;
  /** Take the cursor once mounted, after the text (the composer opening from its folded line). */
  autoFocus?: boolean;
}) {
  const [m, setM] = useState<typeof Monaco | null>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const scheme = useColorScheme();
  const [pasted, setPasted] = useState<{
    start: number;
    length: number;
    plain: string;
    /** The whole text right after the paste: any other change forgets the paste. */
    after: string;
  } | null>(null);
  // Monaco takes over from the text box with its cursor when the text box had it.
  const handOver = useRef<[number, number] | null>(null);
  const latest = useRef({ value, onChange, onSubmit });
  latest.current = { value, onChange, onSubmit };
  // The text box's selection to restore once React has written a value from the toolbar.
  const pendingSel = useRef<[number, number] | null>(null);

  useEffect(() => {
    let live = true;
    loadMonaco().then(
      (x) => {
        if (!live) return;
        const a = area.current;
        if (a && document.activeElement === a)
          handOver.current = [a.selectionStart, a.selectionEnd];
        setM(x);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    m?.editor.setTheme(monacoTheme(scheme));
  }, [m, scheme]);

  useEffect(() => {
    if (!m || !host.current) return;
    const font = getComputedStyle(document.documentElement)
      .getPropertyValue('--font-code')
      .trim();
    const e = m.editor.create(host.current, {
      value: latest.current.value,
      language: 'markdown',
      theme: monacoTheme(currentColorScheme()),
      wordWrap: 'on',
      lineNumbers: 'on',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      placeholder,
      fontFamily: font || undefined,
      fontSize: 13,
      lineHeight: 22,
      padding: { top: 12, bottom: 12 },
      renderLineHighlight: 'none',
      overviewRulerLanes: 0,
      ariaLabel: label,
      // A copy keeps to plain text, so pasting it back is not taken for rich text.
      copyWithSyntaxHighlighting: false,
    });
    e.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () =>
      latest.current.onSubmit(),
    );
    const sub = e.onDidChangeModelContent(() => {
      const v = e.getValue();
      if (v !== latest.current.value) latest.current.onChange(v);
    });
    editor.current = e;
    const model = e.getModel();
    const at =
      handOver.current ??
      (autoFocus ? [model?.getValueLength() ?? 0, 0] : null);
    handOver.current = null;
    if (at && model) {
      e.setPosition(model.getPositionAt(at[0]));
      e.focus();
    }
    return () => {
      sub.dispose();
      e.dispose();
      editor.current = null;
    };
    // The editor is made once; value changes reach it below.
  }, [m]);

  // A value set from outside (a dropped file, a cleared draft) reaches Monaco.
  useEffect(() => {
    const e = editor.current;
    if (e && e.getValue() !== value) e.setValue(value);
  }, [value]);

  useEffect(() => {
    const sel = pendingSel.current;
    const a = area.current;
    if (!sel || !a) return;
    pendingSel.current = null;
    a.focus();
    a.setSelectionRange(sel[0], sel[1]);
  });

  useEffect(() => {
    if (autoFocus && area.current) {
      const a = area.current;
      a.focus();
      a.setSelectionRange(a.value.length, a.value.length);
    }
    // On mount only.
  }, []);

  useEffect(() => {
    if (pasted && value !== pasted.after) setPasted(null);
  }, [value, pasted]);

  useEffect(() => {
    if (!pasted) return;
    const t = setTimeout(() => setPasted(null), PASTED_MS);
    return () => clearTimeout(t);
  }, [pasted]);

  const surface = (): Surface => {
    const e = editor.current;
    const model = e?.getModel();
    if (e && model && m) {
      return {
        selection: () => {
          const s = e.getSelection();
          if (!s) return [0, 0];
          const a = model.getOffsetAt(s.getStartPosition());
          const b = model.getOffsetAt(s.getEndPosition());
          return [Math.min(a, b), Math.max(a, b)];
        },
        replace: (start, end, text, selStart, selEnd) => {
          const p = (o: number) => model.getPositionAt(o);
          const s = p(start);
          const f = p(end);
          // Each toolbar edit, paste and Paste as plain text is its own undo step.
          e.pushUndoStop();
          e.executeEdits('composer', [
            {
              range: new m.Range(
                s.lineNumber,
                s.column,
                f.lineNumber,
                f.column,
              ),
              text,
            },
          ]);
          e.pushUndoStop();
          const a = p(selStart);
          const b = p(selEnd);
          e.setSelection(
            new m.Range(a.lineNumber, a.column, b.lineNumber, b.column),
          );
          e.focus();
        },
      };
    }
    return {
      selection: () => {
        const a = area.current;
        return a
          ? [a.selectionStart, a.selectionEnd]
          : [value.length, value.length];
      },
      replace: (start, end, text, selStart, selEnd) => {
        const v = latest.current.value;
        pendingSel.current = [selStart, selEnd];
        latest.current.onChange(v.slice(0, start) + text + v.slice(end));
      },
    };
  };

  const format = (f: Format) => {
    const s = surface();
    const [start, end] = s.selection();
    const v = latest.current.value;
    const r = applyFormat(f, v, start, end);
    // The edit covers the changed span only, so Monaco's undo keeps the rest.
    let head = 0;
    while (head < start && v[head] === r.text[head]) head++;
    const tail = v.length - end;
    s.replace(
      head,
      v.length - tail,
      r.text.slice(head, r.text.length - tail),
      r.start,
      r.end,
    );
  };

  // Rich text from the clipboard: before Monaco or the text box sees the paste.
  useEffect(() => {
    const w = wrap.current;
    if (!w) return;
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      const types = Array.from(data?.types ?? []);
      // A copy from a code editor (Monaco, VS Code) is text already; so is HTML without formatting.
      if (
        !data ||
        !types.includes('text/html') ||
        types.includes('vscode-editor-data')
      )
        return;
      const html = data.getData('text/html');
      if (!isRichHtml(html)) return;
      const md = htmlToMarkdown(html);
      if (!md) return;
      e.preventDefault();
      e.stopPropagation();
      const s = surface();
      const [start, end] = s.selection();
      const v = latest.current.value;
      s.replace(start, end, md, start + md.length, start + md.length);
      setPasted({
        start,
        length: md.length,
        plain: data.getData('text/plain'),
        after: v.slice(0, start) + md + v.slice(end),
      });
      trackBrain('paste-markdown');
    };
    w.addEventListener('paste', onPaste, true);
    return () => w.removeEventListener('paste', onPaste, true);
  });

  const pastePlain = () => {
    if (!pasted || latest.current.value !== pasted.after) return;
    const { start, length, plain } = pasted;
    surface().replace(
      start,
      start + length,
      plain,
      start + plain.length,
      start + plain.length,
    );
    setPasted(null);
    trackBrain('paste-plain');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="brain-editor" ref={wrap}>
      <div className="brain-editor-bar" role="toolbar" aria-label="Formatting">
        {BUTTONS.map((b) => (
          <button
            key={b.format}
            type="button"
            className="brain-editor-tool"
            aria-label={b.label}
            title={b.label}
            disabled={view === 'preview'}
            // Keep the selection where it is.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format(b.format)}
          >
            {b.icon}
          </button>
        ))}
        <span className="grow" />
        {pasted && (
          <span className="muted small brain-editor-pasted">
            <span>Pasted as Markdown</span>
            <button type="button" className="link small" onClick={pastePlain}>
              Paste as plain text
            </button>
          </span>
        )}
        <div
          className="brain-editor-views"
          role="tablist"
          aria-label="Editor view"
        >
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              className={view === v.id ? 'is-on' : undefined}
              onClick={() => onView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div className={`brain-editor-body is-${view}`}>
        <div className="brain-editor-source" hidden={view === 'preview'}>
          {m ? (
            <div className="brain-editor-monaco" ref={host} />
          ) : (
            <textarea
              ref={area}
              className="brain-editor-text"
              aria-label={label}
              placeholder={placeholder}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
            />
          )}
        </div>
        {view !== 'write' && (
          <div className="brain-editor-preview" aria-label="Preview">
            {value.trim() ? (
              <MarkdownView
                asset={noAsset}
                path="draft.md"
                text={value}
                onOpenDoc={noop}
                onOpenFile={noop}
                idPrefix="draft-"
              />
            ) : (
              <p className="muted small">Nothing to preview yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
