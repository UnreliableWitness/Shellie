// src/renderer/components/EditorSection.tsx
import { useEffect, useState } from 'react';
import type { EditorChoice, EditorId, EditorPrefs } from '../../shared/editors';
import { api, saveSettings, tryInvoke } from '../api';
import { useStore } from '../store';

/** Settings > Editor: the default editor ("Automatic" picks from the project); each repo's own is under Repository › Editor. */
export function EditorSection() {
  const notify = useStore((s) => s.notify);
  const [choices, setChoices] = useState<EditorChoice[] | null>(null);
  const [prefs, setPrefs] = useState<EditorPrefs | null>(null);

  const load = async (refresh: boolean) => {
    const [c, s] = await Promise.all([
      tryInvoke(() => api().invoke('editor:installed', refresh), notify),
      tryInvoke(() => api().invoke('settings:get'), notify),
    ]);
    if (c) setChoices(c);
    if (s) setPrefs(s.editor);
  };
  // Detection runs again whenever Settings opens, so a just-installed editor shows up.
  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  }, []);

  const save = async (change: (p: EditorPrefs) => EditorPrefs) => {
    const saved = await tryInvoke(
      () => saveSettings((fresh) => ({ editor: change(fresh.editor) })),
      notify,
    );
    if (saved) setPrefs(saved.editor);
  };
  const value = (id: EditorId | null) => id ?? '';
  const parse = (v: string): EditorId | null =>
    v === '' ? null : (v as EditorId);

  return (
    <section id="editor" className="section">
      <div className="section-head">
        <h2>Editor</h2>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void load(true)}
        >
          Look again
        </button>
      </div>
      {choices && choices.length === 0 && (
        <p className="muted">
          No editor found. Install VS Code (with `code` on PATH) or Visual
          Studio, then choose Look again.
        </p>
      )}
      {choices && prefs && (
        <div className="list">
          <label className="list-row">
            <span className="grow">Default editor</span>
            <select
              className="field"
              aria-label="Default editor"
              value={value(prefs.default)}
              onChange={(e) => {
                // Read the value now: the controlled select resets before save's callback runs.
                const editor = parse(e.target.value);
                void save((p) => ({ ...p, default: editor }));
              }}
            >
              <option value="">Automatic</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <p className="small muted">
        Automatic opens Visual Studio for a repo with a .sln or .csproj when it
        is installed, else VS Code.
      </p>
    </section>
  );
}
