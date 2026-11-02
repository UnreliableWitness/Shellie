import { useEffect, useState } from 'react';
import type {
  EditorChoice,
  EditorId,
  EditorPrefs,
} from '../../../../shared/editors';
import type { Repo } from '../../../../shared/types';
import { api, saveSettings, tryInvoke } from '../../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { useStore } from '../../../store';

/**
 * This repo's editor (`editor.repos[id].editor` in settings.json); the stored Visual Studio solution is kept. The
 * solution is picked from a worktree's Open in menu, since listing solutions needs a task's worktree.
 */
export function RepoEditorCategory({
  repo,
  active,
  title,
}: {
  repo: Repo;
  active: boolean;
  title: string;
}) {
  const notify = useStore((s) => s.notify);
  const [choices, setChoices] = useState<EditorChoice[] | null>(null);
  const [prefs, setPrefs] = useState<EditorPrefs | null>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    void Promise.all([
      tryInvoke(() => api().invoke('editor:installed'), notify),
      tryInvoke(() => api().invoke('settings:get'), notify),
    ]).then(([c, s]) => {
      if (!live) return;
      if (c) setChoices(c);
      if (s) setPrefs(s.editor);
    });
    return () => {
      live = false;
    };
  }, [active, notify]);

  const chosen = prefs?.repos[repo.id]?.editor ?? null;
  const save = async (editor: EditorId | null) => {
    const saved = await tryInvoke(
      () =>
        saveSettings((fresh) => ({
          editor: {
            ...fresh.editor,
            repos: {
              ...fresh.editor.repos,
              [repo.id]: {
                solution: fresh.editor.repos[repo.id]?.solution ?? null,
                editor,
              },
            },
          },
        })),
      notify,
    );
    if (saved) setPrefs(saved.editor);
  };

  return (
    <SettingsCategory id="repo-editor" title={title}>
      <SettingRow
        id="repo-editor-choice"
        scope="repo"
        category="Editor"
        title="Editor for this repo"
        description="Open in uses it for this repo's worktrees; Default follows the default editor under User."
        keywords={['VS Code', 'Visual Studio', 'open in', 'solution']}
        modified={chosen !== null}
        onReset={() => void save(null)}
      >
        {choices && prefs ? (
          <select
            className="field"
            aria-label={`Editor for ${repo.name}`}
            value={chosen ?? ''}
            onChange={(e) => {
              // Read the value now: the controlled select resets before save's callback runs.
              const v = e.target.value;
              void save(v === '' ? null : (v as EditorId));
            }}
          >
            <option value="">Default</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        ) : (
          <div className="muted small">Loading&hellip;</div>
        )}
      </SettingRow>
    </SettingsCategory>
  );
}
