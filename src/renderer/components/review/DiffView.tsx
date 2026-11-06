// src/renderer/components/review/DiffView.tsx
import type * as Monaco from 'monaco-editor';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReviewSide } from '../../../shared/review';
import { loadMonaco } from '../../review/loadMonaco';
import { type LineChange, mapOriginalLine } from '../../review/mapOriginalLine';
import { errorMessage } from '../../../shared/errors';
import type { ColorScheme } from '../../../shared/theme';
import { currentColorScheme, useColorScheme } from '../../colorScheme';

const monacoTheme = (s: ColorScheme) => `shellie-${s}`;

export type DiffZone = {
  id: string;
  side: ReviewSide;
  afterLine: number;
  node: ReactNode;
};
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
export type DiffKey =
  | 'j'
  | 'k'
  | 'n'
  | 'p'
  | 'v'
  | 'c'
  | (typeof DIGITS)[number];
export type DiffViewHandle = {
  goToChange(dir: 'next' | 'previous'): void;
  selection(): { side: ReviewSide; startLine: number; endLine: number } | null;
  focus(): void;
};
type Props = {
  /** Unique per file (`<workspaceId>/<path>`); a new key is a new file, the same key keeps scroll and zones. */
  uriKey: string;
  before: string;
  after: string;
  sideBySide: boolean;
  ignoreWhitespace: boolean;
  hideUnchanged: boolean;
  zones?: DiffZone[];
  onGlyph?: (side: ReviewSide, line: number) => void;
  onKey?: (key: DiffKey) => void;
  onReady?: (h: DiffViewHandle | null) => void;
  /** Scrolls a line into the centre of a side whenever `seq` changes. */
  reveal?: { side: ReviewSide; line: number; seq: number };
  /** Called once a `reveal` has been carried out, so the owner can drop it. */
  onRevealed?: () => void;
  /**
   * Scroll and cursor per `uriKey`, owned by the caller so they outlive this view: a file's view is
   * saved when another file is shown or the view unmounts, and restored when the file is shown again.
   */
  viewStates?: Map<string, unknown>;
};

/**
 * Events inside a comment card must not reach Monaco (its keybindings and mouse handling).
 *
 * A card is not drawn in its view zone: Monaco puts view zones under the text layer, so a click
 * there hits the code instead, and a zone is as wide as the longest line, so a card in it went off
 * the right edge (#71). The zone only keeps the space open; the card is an overlay widget, laid over
 * the zone, as wide as the visible code, as VS Code's own comment widget does.
 */
const SHIELD = [
  'keydown',
  'keyup',
  'keypress',
  'mousedown',
  'pointerdown',
  'contextmenu',
  'paste',
  'copy',
  'cut',
];

export function DiffView(p: Props) {
  const scheme = useColorScheme();
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(p);
  latest.current = p;
  const [m, setM] = useState<typeof Monaco | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [diff, setDiff] = useState<Monaco.editor.IStandaloneDiffEditor | null>(
    null,
  );
  const [lineChanges, setLineChanges] = useState<LineChange[]>([]);
  const [mounted, setMounted] = useState<{ id: string; dom: HTMLElement }[]>(
    [],
  );
  // The node each zone's portal renders into, per zone id. A rebuild of the Monaco view zones puts
  // the same node in the new zone, so the portal (and the state of what it shows, an edit in a
  // comment card for one) stays mounted; a node goes when its zone id does.
  const zoneNodes = useRef(new Map<string, HTMLElement>());
  // The uriKey whose models the diff editor shows.
  const shown = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    loadMonaco().then(
      (x) => live && setM(x),
      (e) => live && setFailed(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  // Monaco themes are global: one call re-colours every editor.
  useEffect(() => {
    m?.editor.setTheme(monacoTheme(scheme));
  }, [m, scheme]);

  useEffect(() => {
    if (!m || !host.current) return;
    const font = getComputedStyle(document.documentElement)
      .getPropertyValue('--font-code')
      .trim();
    const d = m.editor.createDiffEditor(host.current, {
      theme: monacoTheme(currentColorScheme()),
      readOnly: true,
      originalEditable: false,
      domReadOnly: true,
      automaticLayout: true,
      glyphMargin: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderSideBySide: latest.current.sideBySide,
      // The Side by side toggle means what it says: no silent switch to inline on narrow windows.
      useInlineViewWhenSpaceIsLimited: false,
      ignoreTrimWhitespace: latest.current.ignoreWhitespace,
      hideUnchangedRegions: { enabled: latest.current.hideUnchanged },
      fontSize: 13,
      ...(font ? { fontFamily: font } : {}),
    });
    const sides: [ReviewSide, Monaco.editor.IStandaloneCodeEditor][] = [
      ['before', d.getOriginalEditor()],
      ['after', d.getModifiedEditor()],
    ];
    const subs: Monaco.IDisposable[] = [];
    const keys: [DiffKey, number][] = [
      ['j', m.KeyCode.KeyJ],
      ['k', m.KeyCode.KeyK],
      ['n', m.KeyCode.KeyN],
      ['p', m.KeyCode.KeyP],
      ['v', m.KeyCode.KeyV],
      ['c', m.KeyCode.KeyC],
      // Digit0 to Digit9 are consecutive key codes: the repo filter.
      ...DIGITS.map((d, i): [DiffKey, number] => [d, m.KeyCode.Digit0 + i]),
    ];
    for (const [side, ed] of sides) {
      let hover: string[] = [];
      subs.push(
        ed.onMouseMove((e) => {
          const line = e.target.position?.lineNumber;
          hover = ed.deltaDecorations(
            hover,
            line && latest.current.onGlyph
              ? [
                  {
                    range: new m.Range(line, 1, line, 1),
                    options: { glyphMarginClassName: 'review-add-glyph' },
                  },
                ]
              : [],
          );
        }),
        ed.onMouseLeave(() => {
          hover = ed.deltaDecorations(hover, []);
        }),
        ed.onMouseDown((e) => {
          if (
            e.target.type === m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
            e.target.position
          )
            latest.current.onGlyph?.(side, e.target.position.lineNumber);
        }),
      );
      // Plain letters only (Cmd/Ctrl+C still copies). An action is scoped to this editor, and
      // `editorTextFocus` keeps the letters typeable in the find widget.
      for (const [key, code] of keys)
        subs.push(
          ed.addAction({
            id: `shellie.review.${key}`,
            label: `Review: ${key}`,
            keybindings: [code],
            keybindingContext: 'editorTextFocus',
            run: () => latest.current.onKey?.(key),
          }),
        );
    }
    subs.push(
      d.onDidUpdateDiff(() => setLineChanges(d.getLineChanges() ?? [])),
    );
    const handle: DiffViewHandle = {
      goToChange: (dir) => d.goToDiff(dir),
      // In the inline view only the modified editor is shown, so the "+" and the selection
      // offer the after side only.
      selection: () => {
        const focused = sides.find(([, ed]) => ed.hasTextFocus()) ?? sides[1];
        const s = focused[1].getSelection();
        if (!s) return null;
        // A selection that ends at column 1 of the next line covers the lines above it.
        const end =
          s.endLineNumber > s.startLineNumber && s.endColumn === 1
            ? s.endLineNumber - 1
            : s.endLineNumber;
        return { side: focused[0], startLine: s.startLineNumber, endLine: end };
      },
      focus: () => d.getModifiedEditor().focus(),
    };
    setDiff(d);
    latest.current.onReady?.(handle);
    return () => {
      latest.current.onReady?.(null);
      if (shown.current)
        latest.current.viewStates?.set(shown.current, d.saveViewState());
      shown.current = null;
      for (const s of subs) s.dispose();
      const model = d.getModel();
      d.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      setDiff(null);
    };
  }, [m]);

  useEffect(() => {
    diff?.updateOptions({
      renderSideBySide: p.sideBySide,
      ignoreTrimWhitespace: p.ignoreWhitespace,
      hideUnchangedRegions: { enabled: p.hideUnchanged },
    });
  }, [diff, p.sideBySide, p.ignoreWhitespace, p.hideUnchanged]);

  useEffect(() => {
    if (!m || !diff) return;
    const uri = (side: ReviewSide) =>
      m.Uri.from({ scheme: 'shellie-review', path: `/${side}/${p.uriKey}` });
    const cur = diff.getModel();
    if (cur && cur.modified.uri.toString() === uri('after').toString()) {
      // The same file changed on disk: keep the reader's place.
      const view = diff.saveViewState();
      if (cur.original.getValue() !== p.before) cur.original.setValue(p.before);
      if (cur.modified.getValue() !== p.after) cur.modified.setValue(p.after);
      if (view) diff.restoreViewState(view);
      return;
    }
    const views = latest.current.viewStates;
    if (cur && shown.current) views?.set(shown.current, diff.saveViewState());
    const original = m.editor.createModel(p.before, undefined, uri('before'));
    const modified = m.editor.createModel(p.after, undefined, uri('after'));
    diff.setModel({ original, modified });
    shown.current = p.uriKey;
    const view = views?.get(p.uriKey);
    if (view) diff.restoreViewState(view as Monaco.editor.IDiffEditorViewState);
    cur?.original.dispose();
    cur?.modified.dispose();
  }, [m, diff, p.uriKey, p.before, p.after]);

  useEffect(() => {
    const r = latest.current.reveal;
    if (!diff || !r) return;
    const go = () => {
      // Inline, the original editor is hidden: a before-side line is shown at its mapped line.
      const inline = !latest.current.sideBySide;
      const ed =
        r.side === 'before' && !inline
          ? diff.getOriginalEditor()
          : diff.getModifiedEditor();
      const line =
        r.side === 'before' && inline
          ? mapOriginalLine(r.line, diff.getLineChanges() ?? [])
          : r.line;
      // Moving the cursor also opens a hidden unchanged region around the line (Monaco does that
      // for every cursor move), so the reveal works with Hide unchanged on.
      ed.setPosition({ lineNumber: line, column: 1 });
      ed.revealLineInCenter(line);
      latest.current.onRevealed?.();
    };
    if (diff.getLineChanges() !== null) {
      go();
      return;
    }
    // A new file's diff is not computed yet, so its unchanged regions are not known: wait for it.
    const sub = diff.onDidUpdateDiff(() => {
      sub.dispose();
      go();
    });
    return () => sub.dispose();
    // Only a new seq (or a new file) moves the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, p.reveal?.seq, p.uriKey]);

  const zoneSig = JSON.stringify(
    (p.zones ?? []).map((z) => [z.id, z.side, z.afterLine]),
  );
  // Inline, before-side zones sit in the modified editor at mapped lines, so they move with the diff.
  const inlineMap = p.sideBySide ? '' : JSON.stringify(lineChanges);

  useEffect(() => {
    if (!diff) {
      setMounted([]);
      return;
    }
    const eds = {
      before: diff.getOriginalEditor(),
      after: diff.getModifiedEditor(),
    };
    const inline = !latest.current.sideBySide;
    const changes: LineChange[] = inline
      ? (JSON.parse(inlineMap) as LineChange[])
      : [];
    const made: {
      id: string;
      host: ReviewSide;
      zoneId: string;
      widget: Monaco.editor.IOverlayWidget;
      inner: HTMLElement;
      ro: ResizeObserver;
    }[] = [];
    // Each card spans the code area of its editor: right of the line numbers, left of the scrollbar.
    const fitCards = (host: ReviewSide) => {
      const i = eds[host].getLayoutInfo();
      for (const x of made)
        if (x.host === host) {
          const dom = x.widget.getDomNode();
          dom.style.left = `${i.contentLeft}px`;
          dom.style.width = `${Math.max(0, i.width - i.contentLeft - i.verticalScrollbarWidth - i.minimap.minimapWidth)}px`;
        }
    };
    // The inline view hides the original editor: every zone goes to the modified one there.
    const placed = (latest.current.zones ?? []).map((z) => ({
      z,
      host: inline ? ('after' as const) : z.side,
      line:
        inline && z.side === 'before'
          ? mapOriginalLine(z.afterLine, changes)
          : z.afterLine,
    }));
    for (const host of ['before', 'after'] as const) {
      eds[host].changeViewZones((acc) => {
        for (const { z, line } of placed.filter((x) => x.host === host)) {
          const dom = document.createElement('div');
          dom.className = 'review-zone';
          for (const ev of SHIELD)
            dom.addEventListener(ev, (e) => e.stopPropagation());
          let inner = zoneNodes.current.get(z.id);
          if (!inner) {
            inner = document.createElement('div');
            zoneNodes.current.set(z.id, inner);
          }
          dom.appendChild(inner);
          const node = inner;
          // Off screen until Monaco reports where the zone is.
          dom.style.top = '-1000px';
          const zone: Monaco.editor.IViewZone = {
            afterLineNumber: line,
            heightInPx: 96,
            domNode: document.createElement('div'),
            suppressMouseDown: true,
            onDomNodeTop: (top) => {
              dom.style.top = `${top}px`;
            },
          };
          const zoneId = acc.addZone(zone);
          const widget: Monaco.editor.IOverlayWidget = {
            getId: () => `shellie.review.zone.${host}.${zoneId}`,
            getDomNode: () => dom,
            getPosition: () => null,
          };
          eds[host].addOverlayWidget(widget);
          const ro = new ResizeObserver(() => {
            const h = node.offsetHeight + 8;
            if (h > 8 && Math.abs(h - (zone.heightInPx ?? 0)) > 1) {
              zone.heightInPx = h;
              eds[host].changeViewZones((a) => a.layoutZone(zoneId));
            }
          });
          ro.observe(node);
          made.push({ id: z.id, host, zoneId, widget, inner: node, ro });
        }
      });
      fitCards(host);
    }
    const layouts = (['before', 'after'] as const).map((host) =>
      eds[host].onDidLayoutChange(() => fitCards(host)),
    );
    const ids = new Set(placed.map((x) => x.z.id));
    for (const id of zoneNodes.current.keys())
      if (!ids.has(id)) zoneNodes.current.delete(id);
    // Same ids, same nodes: React keeps those portals and their state.
    setMounted(made.map((x) => ({ id: x.id, dom: x.inner })));
    return () => {
      for (const l of layouts) l.dispose();
      for (const x of made) {
        x.ro.disconnect();
        eds[x.host].removeOverlayWidget(x.widget);
      }
      for (const host of ['before', 'after'] as const)
        eds[host].changeViewZones((acc) => {
          for (const x of made) if (x.host === host) acc.removeZone(x.zoneId);
        });
    };
    // Zones are rebuilt when their ids or lines change, a new file is shown (setModel clears
    // them), the view switches between side by side and inline, or (inline) the diff changes.
  }, [diff, zoneSig, p.uriKey, p.sideBySide, inlineMap]);

  const nodes = new Map((p.zones ?? []).map((z) => [z.id, z.node]));
  if (failed)
    return (
      <div className="review-empty">{`The diff viewer could not load: ${failed}`}</div>
    );
  return (
    <>
      <div ref={host} className="review-diff" />
      {mounted.map((x) => createPortal(nodes.get(x.id) ?? null, x.dom, x.id))}
    </>
  );
}
