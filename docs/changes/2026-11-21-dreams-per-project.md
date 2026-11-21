# Dreams per project

Spec `docs/superpowers/specs/2026-11-21-dreams-per-project-design.md` (Part 1), plan
`docs/superpowers/plans/2026-11-21-dreams-per-project.md`. Builds on `2026-11-20-dreams.md`. Part 2 of the spec (a
pull request straight from a dream, and an agent that is told about the dream) is a separate change.

The owner found one dream setup and one Dreams list for every project confusing. Dreaming now belongs to a project
(an Azure DevOps connection): its switch, model, daily limit, idle minutes, repos, results, journal and notices.

## How it works

- **Settings** (`src/shared/dreams.ts`, `src/shared/usage.ts`, `SettingsStore`). `dreaming` holds one block per
  connection id (`projects`), each with the fields the single block had. `SettingsStore.updateDreaming` is still the
  only writer (the dream handlers and the scheduler write one project's block through it). A project without a block is off.
- **The old setup** (`toProjects` in `startDreams.ts`, at the first start that knows the repos). The single block is
  kept as `legacy` when the file loads, then copied to every project that owns one of its repos, each copy with that
  project's repos only; a copy is on only when the old setup was on and the copy still has a repo that is on with a
  folder. The limit is copied, not divided, so the day's total over all projects can be higher than before. Repos
  without a project and repos Shellie no longer knows are dropped. With no repo known at that start, the old setup
  waits for the next one.
- **Usage and limit**. A dream session's title carries its project (`Shellie dream <connection id>: propose`), and
  `OpenCodeReader.dreamTokens` counts by that prefix, matched as written. The setup's model test counts for the
  project it was run for. Sessions of before this change carry no project and count toward none.
- **Scheduler** (`scheduler.ts`). Each minute every project with a setup is checked with the same rules as before
  (its own idle minutes, model, limit and repos); of the projects that could dream, the one whose last dream is
  longest ago starts, and the others wait. Still one dream at a time. A repo dreams only for the project it is in.
- **Wrong model**. When another model answers a dream or a re-test, every project whose chosen model is that model
  is switched off, its passed test forgotten, each with its own stored notice (`switchedOffBy` in `dreams.json`).
  The old single notice goes to its repo's project, or to every project on that model when it names no repo.
- **IPC**. `dream:get`, `dream:test`, `dream:save`, `dream:switchOn`, `dream:switchOff` and `dream:stop` take the
  connection id; the calls about one repo's result keep their arguments. `dream:get` returns the project's repos,
  their journal lines, its usage and its wait. While a dream of another project runs the wait is
  `running-elsewhere` ("Another project is dreaming") and nothing else of that dream is in the view. Saving a repo
  of another project is refused.
- **Screens**. Dreams, the setup, the Dreams navigation item and its count, the Home band and the status line read
  the active project's view (`useDreams`), and read again when the active project changes. Without a project there
  is no Dreams item, band or status line. The Dreaming section moved from Settings › User to Settings › Project and
  shows the picked project; its Open Dreams button makes that project the active one.
- **Projects and repos that change**. Removing a project removes its block and notice; a repo linked to another
  project leaves its old block (`pruneDreaming`), which goes off when nothing is left, and is off in the new project
  until it is set up there. A dream running for it stops (found by the final review: the first version asked the
  view of the project, which no longer named the dream once its repo had moved; it now asks the scheduler).
- **A repo without a project** does not dream and is not offered in any setup. If it still has a result or an
  opened branch from before, that shows in every project's Dreams screen until reviewed.

## Decisions Claude made

- Repos without a project stop dreaming.
- A wrong model switches off every project on that model, not only the one that dreamt.
- Between projects, the one whose last dream is longest ago goes first.
- The limit is copied to each project.
- A project id that is not letters, digits, `-` or `_` is refused for a dream's title (it goes on a command line).
- The navigation's status line never mentions another project's dream; the Dreams screen's Now cell says "Another
  project is dreaming".

## Verified

- Unit and component tests for each part: the settings shapes and the split of the old block, the store's single
  writer, usage per project by title, the limit per project, the per-project notice and its move, the scheduler
  with two and three projects (order, own idle minutes and limit, wrong model, Stop), the move at start, every
  changed IPC call with two projects, and the screens with a project, with another one, and with none.
- `npm test`, `npm run typecheck`, `npm run lint`.
- **The dev app** (macOS, a scratch data folder, driven over the DevTools protocol), with two projects and one
  throwaway repo in each. The test Azure DevOps organization has one project, so the second project was a copy of
  the first's stored connection under another name, written into the scratch folder; its repo list calls fail,
  which the check did not need. Seen:
  - a settings file with the old single setup (on, both repos and one unknown repo) became one block per project
    at the start, each on with its own repo only, the unknown repo dropped, and the old block gone;
  - with a stored result for the first project's repo: that project showed "Dreams 1", the Home band with the
    proposal, the result under Waiting for you and its journal line; the second project showed no count, no band,
    "Nothing waits for you" and "No dreams yet";
  - Switch off in the second project left the first on (the screens and the settings file);
  - Settings › Project shows the Dreaming section; Settings › User no longer does.

## Not verified, and known gaps

- Not seen in the running app: a dream actually running (so "Another project is dreaming", usage counted per
  project from OpenCode's database, and a wrong model stopping several projects are covered by tests only), the
  setup screen being used, a repo linked to another project, and removing a project.
- Home lists tasks and pull requests of every project, but its "While you were away" band shows the active
  project's dreams only.
- Not run on Windows.
- The journal lines of a repo that was removed, or that has no project and nothing to review, show in no project
  (the file keeps them).
- A project switched off because another project's dream was answered by a wrong model gets the same notice text
  as that project ("a call in a dream"), without a repo name.
- A downgrade to a version from before this change reads the new `dreaming` shape as not valid: dreaming is off
  there and the setup must be made again.
- Token usage of dreams from before this change no longer counts toward any limit (a matter of the day of the
  update only).
- The title of a dream session in OpenCode's own session list now shows the connection id.
- The Home band and the Dreams count of a project do not say that another project has results waiting.
