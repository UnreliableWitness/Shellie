# Brain Add view: one composer

Date: 2026-11-10. Status: design, awaiting the owner's approval.

Mockups: the Claude Design canvas https://claude.ai/artifact/HNagkGz94qedVqMRGP13Mu, three screens: 1 · Composing (text, two files, one note), 2 · Empty composer with files dragged over, 3 · Right after Add. They are the UI reference; the sample text, file names and numbers in them are made up.

## Why

The owner finds the Add view's UX poor: "fields are too small, unfocussed. double fields".

- **Too small.** The paste form puts Title, Type, Note and a three-line textarea in one row; the note, which steers the capture most, is a one-line input.
- **Double fields.** Type and Note exist twice: on the paste form and again on every dropped file (`PendingFiles`), each block with its own Add button. Two ways to add, side by side.
- **Unfocused.** Adding competes with How it works, Waiting to capture, Recent work, What runs by itself, Run now and Health; nothing on the page says "this is what you do here".

The owner also wants "a nice editor that understands markdown", decently advanced, so pasted input can be edited before it goes in, and the choice of model for one add ("use opus for a big ppt deck").

## Goals

- **One composer** owns the top of the Add view: a title, a real Markdown editor, the attached files, one note, one Add.
- **A decently advanced Markdown editor**: syntax highlighting, a formatting toolbar, Write / Split / Preview, and paste of rich text (an email, a Teams thread, a web page) turned into Markdown.
- **One note for the whole add**, sized as a real field; a file gets its own note only when asked for.
- **Type guessed**, shown small, changeable.
- **The model for this one add**: a "Capture with" choice that defaults to the brain's model and changes nothing else.
- **One Activity list** for what happened to what you added, replacing Waiting to capture and Recent work.
- Everything else (automation, Run now, Health, How it works) quieter, out of the composer's way.

## Non-goals

- Editing binary files. PDFs, Word, PowerPoint, Excel, draw.io, VTT and pictures go in as they are, with the note (owner's answer). Their extracted text is not shown or edited.
- Changing the brain's default model from the composer. The choice is for that one add only (owner's answer); the default stays in Settings › Brains.
- Changing capture, lint, sync, the skills, the job queue's order or the scheduler. The only job change is carrying a model override (below).
- The Read view, and the task's Brain tab (`BrainTab`), which keeps its own drop and `PendingFiles` flow. It must not regress if `useBrainDrop` changes.
- An undo of an add. Capture starts at once, so it would rarely apply; Remove source in Read stays the way out.

## Anti-goals

- The double fields coming back in another form: per-file Type and Note inputs always visible on every row.
- An editor that loses what you typed: switching to Read and back, or to another brain and back, must keep the draft.
- A model choice that silently sticks: the next add starts again on the brain's model.
- A heavy view: Monaco must load lazily (as the Changes tab does), and the view must render and accept drops before it has loaded.

## Constraints

- Shellie's look: `tokens.css` (dark and light), `brain.css`, existing controls (`.btn`, `.field`, `HelpTip`). The mockups are dark; the light theme must work too.
- Agent-neutral texts (Claude Code or OpenCode): "the agent", never "Claude". The model names in the picker are the exception.
- Monaco is already a dependency (`monaco-editor`, loaded by `src/renderer/review/loadMonaco.ts`); the Markdown preview reuses Read's renderer (`react-markdown` + `remark-gfm`, the same sanitizing as `BrainPage`). Converting pasted HTML to Markdown needs a converter; the builder picks one (for example `turndown` with its GFM plugin) and pins it.
- Telemetry: new actions go into `brain.screen.action` and `docs/telemetry.md`, counts and kinds only (never text, titles, file names or notes). The model choice may be sent as `haiku`/`sonnet`/`opus`/`opencode`, never an OpenCode model string.
- TDD, Vitest and Testing Library; `npm test`, `npm run typecheck`, `npm run lint` green; a change note in `docs/changes/`.

## The view

Two columns, as today: the main column (composer, then Activity) and a side panel of about 300 px. At narrow widths the side panel goes under the main column.

### The composer

Top to bottom (screen 1):

1. **Header.** "Add to <brain name>" and a "?" button that opens How it works as a popover (today's four steps, same text). The How it works card and its Hide link go away.
2. **Title.** One large, borderless input. Optional: empty takes the text of the first Markdown heading, else the first non-empty line cut to 60 characters (my call). The renderer works it out and sends it to `brain:addText`, which is unchanged; today an empty title is stored as `""` with the slug `source`, which this replaces. Used only for the text; files keep their names.
3. **Toolbar.** Heading, bold, italic, bulleted list, checklist, link, code, table; then Write / Split / Preview. Split is the default on a wide window, Write on a narrow one; the choice is remembered (local storage, per viewer).
4. **Editor.** Monaco in Markdown mode, about 330 px tall and resizable, Shellie's colors, word wrap on, line numbers on, no minimap. Preview renders as Read does. The toolbar acts on the selection (wrap, prefix lines). Ctrl+Enter (Cmd+Enter on macOS) adds.
   - **Rich paste.** Pasting `text/html` turns it into GitHub-flavored Markdown (headings, lists, links, bold, tables, quotes); a short line in the toolbar says so ("Pasted as Markdown") with an undo that puts back the plain text. Plain text pastes as is. Images in the clipboard are not pasted into the text (they could be attached as files: builder's call, not required).
5. **Attached files.** Chips under the editor, one per file: an icon by format, the name, the size, the guessed type as a small pill (a select), a remove ×, and an **Own note** link that opens a one-line note for that file only. "Attach files" opens the file picker.
6. **Note for the agent.** A two-line, resizable textarea, full width, with the hint "Goes with the text and every file. What is this, what matters, what is outdated?". It goes into the frontmatter of every source in this add; a file with an own note gets its own note instead (not both).
7. **Footer.** "Text goes in as" (the text's type, default `note`), **Capture with** (below), Discard, and the primary button, whose label counts what goes in: "Add", "Add text", "Add 2 files", "Add text and 2 files". It is disabled when there is neither text nor a file. Discard clears the draft after a confirm when it holds more than a few words.

An empty composer (screen 2) shows the placeholder "Write or paste here. Markdown works … Drop files anywhere on this page." and a disabled Add.

### Dropping

The whole Add view is the drop target, as today (screen 2). While files are over it, an overlay lists what will happen to each: "opens in the editor" or "attached as it is", and the accepted formats.

- A Markdown or text file (`.md`, `.markdown`, `.txt`) dropped while the editor is empty opens in the editor, its file name (without the extension) as the title and "Text goes in as" set to `doc`, the type such a file gets today (my call). It is then added through `brain:addText` like typed text, so its slug comes from that title, which matches today's slug from the file name. Any further text file becomes a chip like any other file (my call: one editor, no tabs).
- Every other file becomes a chip.
- Files without a path on disk and unsupported formats show today's problem lines.

### Capture with (the model for this add)

A pill in the footer, defaulting to the brain's model: Haiku, Sonnet or Opus for a Claude Code brain (`brain.options.model`); for an OpenCode brain the models `agents:opencodeModels` lists, with the brain's `opencodeModel` (or OpenCode's default) first. The brain's own model is labelled "(brain default)".

- It applies to the captures of this add only, text and files alike. The pill resets to the brain's model after Add and when the draft is discarded. It is not saved with the draft across app restarts (my call).
- **Hint, never a switch.** When a deck, or any file over 5 MB, is attached and the pill is not on the strongest model, a muted line next to it suggests it ("Opus may capture the deck better"). The builder may refine the rule; it never changes the pill by itself.
- **What the job does with it.** `BrainJob` gains `model: string | null` (null = the brain's). `brain:addFiles` and `brain:addText` take an optional model and pass it to a new `enqueue` option (`opts: { background?, model? }`); `runSkill` uses `job.model ?? d.model(brainId)` for Claude Code and `job.model ?? d.opencodeModel(brainId)` for OpenCode (still through `opencodeModelArg`, so an invalid string falls back to OpenCode's default). A Claude Code override must be one of `haiku|sonnet|opus` (validated in main). If the brain's agent changes between queueing and running, a model for the other agent is dropped and the brain's model is used.
- **Retry** of a failed capture keeps the job's model (`brain:run` takes the optional model). A **pictures** job queued by that capture's source keeps the brain's model; lint, sync, digest and every automatic job use the brain's model (my call: the override is about reading the source, not maintaining the wiki).
- Activity shows the model on a row only when it differs from the brain's.

### Draft

The composer's draft (title, text, note, type, files with their types and own notes, editor view) lives per brain in the renderer store under its own key, separate from `brainPending`, which stays the task's Brain tab's list as today (my call: a file dropped in a task's Brain tab no longer shows up in the Add view, and the composer's Add never sends files dropped there). It so it survives switching views and brains. It is also kept in local storage per brain so a reload or crash does not lose typed text (my call; files are kept only by path, and a path no longer on disk is dropped with a problem line). The "Draft kept" hint shows only when a draft exists.

### After Add

(screen 3)

- One call per kind, as today: `brain:addText` for the text, `brain:addFiles` for the files, both with the note and the model. Partial failure: what was added leaves the composer, what failed stays with its problem line.
- The composer collapses to a single line ("Write or paste, or drop files…" plus Attach files); focusing it, pasting into it, or dropping expands it again.
- A success line above it ("Added <title> and 2 files. Capturing now; you can keep adding."), dismissable, gone on the next add. The per-file lines and picture progress `AddedNotes` shows today move into the Activity rows of those sources.

### Activity

One card replacing Waiting to capture and Recent work, newest first. Its data is main's job list (`brain.jobs`, kept while the app runs, as Recent work uses today) plus `waitingSources` (my calls throughout this section):

- **A source and its jobs are one row.** A source with a capture, pictures or retract job shows once, with its newest such job's status. A job without a source (lint, sync, digest, refresh, the book) is a row of its own.
- **Just added**: rows whose newest job is queued or running, whatever started it (this view, a task's Brain tab, Run now, the scheduler). Background jobs (the one-time pictures pass, the book) show here only while running.
- **Needs you**: the sources `waitingSources` counts for the user, as today: failed captures and files put in the folder by hand. A failed capture shows here only, not again under Earlier. Its button is Retry when a failed job exists (keeping that job's model), else Capture (the brain's model); Capture all stays.
- **Earlier**: everything finished, done or failed jobs without a source included.
- Filter tabs: All, Needs you · n (sources), Running · n (queued and running rows), Done.

Each row keeps what today's rows do: status, kind and source, why it waits, Capture / Capture all, Retry, Continue in terminal, "n pages changed" (opens the page in Read), Takeaways, picture progress, and the model when overridden. The "Needs you" count is the same number as the Add badge (unchanged rule). With nothing at all, the card shows one muted line.

### The side panel

Runs by itself (which already holds the daily token cap row), Run now and Health stay, in the order and with the behavior they have now, but tighter: smaller headings and plain rows rather than tags. Every Run now button keeps its help. No setting moves.

## Telemetry

New `brain.screen.action` values (the builder names them): add (with counts of text/files, whether a note and own notes were given, the model kind and whether it was overridden), rich paste converted, paste conversion undone, editor view changed, discard. Listed in `docs/telemetry.md`.

## Testing

- Renderer tests: the composer adds text, files, and both in one press, with one note and with own notes; the button label counts; Discard; draft kept across a remount and restored from local storage; a dropped `.md` opens in an empty editor and becomes a chip otherwise; Capture with defaults, resets after Add, lists OpenCode models for an OpenCode brain; Activity groups and the Needs you count match the badge.
- The editor is mocked in renderer tests (Monaco does not run in jsdom); the rich-paste conversion is a pure function with its own tests (lists, links, tables, a Teams-style thread, script and style stripped).
- Main tests: a model passed to `addFiles`/`addText` reaches the job and the command line (`--model opus`, `-m provider/model`); an invalid Claude model is refused; retry keeps it; a pictures or lint job uses the brain's model; a model for the other agent is dropped.
- A packaged run or the dev app on both platforms before merge: paste from a real email and a Teams message, drop a deck, add with Opus, check the job's command line.

## Left to the builder

Component split and file names; the exact toolbar icons (Fluent icons are already a dependency); Monaco theme details; the HTML-to-Markdown library; the big-file hint rule; narrow-window breakpoints; light-theme colors from `tokens.css`; whether `BrainInbox.tsx` is split up.
