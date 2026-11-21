import { useState } from 'react';
import type { DreamingSettings, DreamView } from '../../../shared/dreams';
import { api } from '../../api';
import { folderProblem } from './folders';

/** One repo of step 4: its tick box, folder chips and Add folder / Choose folder. */
export function RepoRow({
  repo,
  settings,
  onChange,
}: {
  repo: DreamView['repos'][number];
  settings: DreamingSettings;
  onChange: (rec: { on: boolean; folders: string[] }) => void;
}) {
  const rec = settings.repos[repo.id];
  const found = !rec && repo.suggestedFolders.length > 0;
  const folders = rec ? rec.folders : repo.suggestedFolders;
  const on = rec?.on ?? false;
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // The folder already warned about: a second Add takes it (a dream may create it).
  const [warned, setWarned] = useState<string | null>(null);

  const add = async () => {
    const value = text.trim();
    const why = folderProblem(value);
    if (why) {
      setProblem(why);
      return;
    }
    if (!folders.includes(value) && warned !== value) {
      // Git paths are case-sensitive: `.APM` is not `.apm`. A check that fails warns of nothing.
      const exists = await api()
        .invoke('dream:folderExists', repo.id, value)
        .catch(() => true);
      if (!exists) {
        setWarned(value);
        setProblem(
          `${value} was not found in ${repo.name}. Check upper and lower case.`,
        );
        return;
      }
    }
    setWarned(null);
    if (!folders.includes(value))
      onChange({ on, folders: [...folders, value] });
    setText('');
    setProblem(null);
    setAdding(false);
  };

  return (
    <div className="dream-repo">
      <label className="dream-repo-name">
        <input
          type="checkbox"
          checked={on}
          disabled={folders.length === 0}
          onChange={(e) => onChange({ on: e.target.checked, folders })}
        />
        <span>{repo.name}</span>
      </label>
      <ul className="dream-chips" aria-label={`Folders for ${repo.name}`}>
        {folders.map((f) => (
          <li key={f} className="chip-code">
            <span>{f}</span>{' '}
            <button
              type="button"
              className="link"
              aria-label={`Remove ${f} from ${repo.name}`}
              onClick={() =>
                onChange({ on, folders: folders.filter((x) => x !== f) })
              }
            >
              &times;
            </button>
          </li>
        ))}
      </ul>
      {found && <span className="muted small">found in the repo</span>}
      {folders.length === 0 && (
        <span className="muted small">
          No agent packages found. Choose a folder before it can dream.
        </span>
      )}
      {!adding && (
        <button
          type="button"
          className="btn btn-sm"
          aria-label={`${folders.length === 0 ? 'Choose folder' : 'Add folder'} for ${repo.name}`}
          onClick={() => setAdding(true)}
        >
          {folders.length === 0 ? 'Choose folder' : 'Add folder'}
        </button>
      )}
      {adding && (
        <form
          className="dream-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            aria-label={`Folder for ${repo.name}`}
            className="field mono"
            placeholder=".apm or AGENTS.md"
            value={text}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="btn btn-sm">
            Add
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setAdding(false);
              setProblem(null);
              setWarned(null);
              setText('');
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {problem && (
        <p role="alert" className="small text-red dream-repo-problem">
          {problem}
        </p>
      )}
    </div>
  );
}
