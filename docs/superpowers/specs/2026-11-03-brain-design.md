# Brain: a local second brain per Azure DevOps project

Design, 2026-11-03. Brainstormed in one session; the decisions below are the owner's unless marked *my call*.

## Intent

A consultancy's knowledge about a customer engagement (what was agreed in the SOW, what was discussed in meetings, what was decided, what the customer's wiki says) is scattered over PDFs, decks, transcripts and an Azure DevOps wiki, and none of it reaches the agent that starts a task. The brain is a folder per Azure DevOps project that Claude Code maintains as a wiki from raw sources, following the "second brain" method (Karpathy's LLM-maintained wiki; the rules as written up at askglitch.com/blog/build-a-second-brain). Shellie feeds it, runs its skills, shows it, and hands it to every task of that project.

The brain is **local** (one git repo on this machine, no remote) and **read-only towards Azure DevOps**: the Azure DevOps wiki is a raw source, never a target. Writing back, sharing with colleagues and publishing are later phases, if ever.

## Goals

- Every task of a project starts with the brain's index in `task.md` and the brain folder readable by its Claude session.
- Feeding is one deliberate act: drop a file, pick a wiki root, paste a note. Conversion is automatic; capture by the LLM runs right after, one source at a time, visibly.
- The four skills (`capture`, `sync`, `lint`, `digest`) are plain Claude Code skills in the brain folder, so the brain works from any Claude Code, with or without Shellie.
- Every token spent on a brain is in the ledger under that brain, visible on Usage, never invoiced and never sent to the cost server.
- Health (lint findings, uncaptured sources, mirror freshness) is visible without opening a terminal.

## Non-goals (phase 1)

- Writing anything to Azure DevOps (wiki pages, work items, attachments).
- Sharing a brain between machines or people. A brain is a git repo; `git remote add` is the documented path, nothing in the UI.
- Capturing session transcripts or diffs of closed tasks. Code knowledge stays in the repo's own docs. A closed task adds one line to `log.md`; capturing its `task.md` is offered, not done.
- Ingesting work item attachments from the work item itself (dropping the downloaded file works).
- OCR of scanned PDFs, images in decks, wiki attachments.
- Skills for Copilot CLI and OpenCode. They get the Context section in `task.md`, nothing else.
- Running anything while the app is closed. No cloud routines, no API key: everything runs through Claude Code on the owner's subscription (see memory: no extra AI costs).
- Claude Code hooks. Shellie never installs hooks in the brain or the worktree.

## Anti-goals

- A wiki that quietly fills with confident mistakes: every page cites sources, lint runs after every capture, findings are shown, and nothing is captured that a person did not put in.
- A second product bolted onto Shellie: no sync engine, no page editor, no chat UI. Shellie's additions are settings, a file pipeline, a terminal owner, a tab and a setup step.
- Customer data in telemetry or on the cost server. Brain names, paths and content never leave the machine except as scrubbed event names.

## Constraints

- Windows is the release target, development on macOS; file conversion, git auth and paths go behind `Platform` or are pure Node.
- The connection's PAT is the only credential; it is read from the encrypted `connections.json` and never written to disk or into a command line in clear.
- `SCHEMA.md`, not `CLAUDE.md`, is the brain's schema file: Claude Code does **not** load `CLAUDE.md` from an `--add-dir` folder (verified 2026-11-03 with Haiku), and the task's agent must not inherit wiki-maintainer instructions anyway.
- The task's agent can edit the brain through `--add-dir` (it grants edit access). Accepted: the Context section says the brain is read-only for the task, and Health shows "edited outside a capture" from the brain's git status.

## The method, as applied

Kept from the article: three layers (`sources/` raw and never edited, `wiki/` maintained by the agent, a schema file), `index.md` and `log.md` (append-only, newest first), frontmatter on wiki pages (`title`, `summary`, `sources`, `last_updated`), every page linked from a parent, inline source citations, the four skills, lint after every batch of writes, a weekly digest, the human as curator, no bulk migration.

Changed: the schema file is `SCHEMA.md`; citations and links are ordinary markdown links (`[Kickoff p.3](../sources/2026-10-09-kickoff.md#p3)`), not `[[wikilinks]]`, so Obsidian and Azure DevOps both render them; the wiki mirror under `sources/wiki/` is refreshed in place and the brain's git history is its audit trail; lint is incremental; people may edit `wiki/` pages (the agent never reverts a human edit; `/sync` adds citations and links, `/lint` reports contradictions).

## Design

### A brain

```
<brain folder>/                  git repo, no remote; opens as an Obsidian vault
  SCHEMA.md                      the rules the skills follow
  index.md                       one line per wiki page: link and summary
  log.md                         append-only, newest first
  sources/                       raw, never edited by the agent
    wiki/<page path>.md          mirror of the chosen Azure DevOps wiki subtree
    2026-10-02-acme-sow.md       converted text; headings per page/slide/timestamp
    2026-10-02-acme-sow.pdf      the original, beside it
    tasks/156-task.md            a closed task's task.md, when the user chose to capture it
  wiki/                          the agent's pages
  brain/state.json               the contract between skills and Shellie (below)
  brain/lock                     one job at a time
  .claude/skills/{capture,sync,lint,digest}/SKILL.md
  .claude/settings.json          permissions: deny Edit/Write under sources/
```

Shellie keeps a `brains.json` in its data folder: `{ id, name, connectionId, project, path, wiki: { wikiId, wikiName, type: 'projectWiki' | 'codeWiki', remoteUrl, version, mappedPath, rootPath } | null, templatesVersion, options }` (`version` is the branch and `mappedPath` the published folder, both from the wikis API; for a project wiki they are `wikiMaster` and `/`). Options: `contextInTaskMd` (default on), `addDirForClaude` (default on), `syncAfterRefresh` (default off), `weeklyDigest` (default off), `dailyTokenCap` (default 500k, *my call*), `openBrainTerminalOnStart` (default off).

"Create brain" scaffolds the folder (or adopts an existing folder that has `SCHEMA.md` and the four skills) and runs `git init` plus a first commit. Default location: `<userData>/brains/<id>`; the user may pick another path.

Scaffolded files come from versioned templates in Shellie (`src/main/brain/templates/`). `templatesVersion` in `brains.json` records which version a brain got. When Shellie ships newer templates, the Brain screen offers "Update skills" with a diff per file; never silent overwrite.

### Which brain a task gets

A task's work item carries its project (`System.TeamProject`, already fetched at setup for `task.md`, #156). Store it on the task's work item reference as `project` (nullable; older tasks null). The brain of a task is the one with the same `connectionId` and `project`. Several brains for one project: a picker in New task (remembered per repo, *my call*). No brain, or a task without a work item: no Brain tab, no Context section, nothing.

### Feeding

**Inbox pipeline** (no LLM):

1. A file is dropped on the Brain screen or on a task's Brain tab, or text is pasted.
2. Shellie converts it to markdown in the main process: PDF (text per page, `## p.N` headings), DOCX (headings and tables kept), PPTX (`## Slide N`, slide text then speaker notes), VTT (`## hh:mm:ss` every minute, speaker labels kept as they are), MD/TXT as they are. Teams exports transcripts as DOCX as well as VTT; the DOCX path covers it. A PDF with no text layer is listed as "needs OCR" and not captured.
3. The result is `sources/YYYY-MM-DD-<slug>.md` with frontmatter `source_url` (file name, or the pasted URL), `ingested_at`, `content_type` (`sow`, `deck`, `doc`, `transcript`, `note`, `task`, `wiki-page`; the user picks or confirms the type in the inbox row, default guessed from the extension), `sha256` of the original. The original is copied beside it. A duplicate `sha256` is refused with a message; a name collision on the same day gets `-2`, `-3`.
4. Shellie commits the source and queues `/capture <file>`.

**Wiki mirror** (no LLM): in settings the user picks a wiki of the project (REST `_apis/wiki/wikis`; both kinds are listed, decided) and a root page from its page tree (REST pages, `recursionLevel=full`), or the wiki root. Shellie clones the wiki's git repo (`remoteUrl` from the wikis API: a project wiki is its own `…/_git/<project>.wiki` repo on `wikiMaster`; a code wiki is the code repo at `version`, with pages under `mappedPath`) into `<userData>/brains/<id>/.mirror`, checking out that branch with a sparse checkout of `mappedPath` + root path, authenticating with the PAT the way `src/main/services/gitAuth.ts` already does for task repos (an `http.extraheader` Basic header passed through `GIT_CONFIG_*` environment variables to `GitClient.run`, never on the command line, never on disk, never in `GitError` messages). Refresh pulls, then copies the `.md` pages under the root into `sources/wiki/<path relative to root>.md`, adding frontmatter (`source_url`: the page's Azure DevOps URL, built per wiki kind, `ingested_at`, `content_type: wiki-page`), removing files for deleted pages, ignoring `.attachments` and `.order`, and commits. Refresh runs on task start (before the Context section is written), once a day while the app is open, and on the button. A failed refresh never blocks a task; Health says "mirror not refreshed since …".

### The skills and the schema

The four skills are short (about 30 lines each) and read `SCHEMA.md` first. What each does:

- `/capture <file>`: read the source, read `index.md`, create or update the affected wiki pages (frontmatter, summary at top, citations, links from a parent), update `index.md`, append to `log.md` (timestamp, source, pages touched, key takeaway), record the source as captured in `state.json`. Ends by printing the takeaways.
- `/sync`: from `state.json`'s last sync commit, diff `sources/` (including the mirror) and `wiki/` (human edits), reconcile the affected pages, log it, advance the marker.
- `/lint`: incremental: pages touched since the last lint plus the pages they link to. Finds broken links, orphans, contradictions, pages whose sources changed after `last_updated`, sources never captured. Writes findings to `state.json` and a summary to `log.md`.
- `/digest`: reads the week's log entries, writes `wiki/digests/<year>-w<nn>.md`, links new pages, logs it.

`SCHEMA.md` holds: the layers, page types (`account`, `scope-*`, `decision-*`, `meeting-*`, `component-*`, `glossary`, `digest`), frontmatter rules, linking and citation rules, the log format, and these rules: record decisions, actions and open questions from meetings, not verbatim quotes; people by role; never copy credentials, rates outside scope pages, or personal opinions about people; when a source contradicts a `scope-*` page, do not overwrite it, write a "possible scope change" finding; never revert a human edit in `wiki/`.

`brain/state.json`:

```json
{
  "schemaVersion": 1,
  "lastSyncCommit": "abc123",
  "lastLintAt": "2026-11-03T10:00:00Z",
  "captured": { "sources/2026-10-02-acme-sow.md": { "at": "...", "sessionId": "..." } },
  "findings": [{ "kind": "contradiction|orphan|broken-link|stale|uncaptured", "page": "wiki/...", "detail": "...", "at": "..." }]
}
```

Skills write it; Shellie reads it for Health and the queue. A malformed file is reported in Health, not fatal.

### Running jobs

Jobs are headless: `claude -p "/capture <file>" --output-format json` in the brain folder (a slash command as the `-p` prompt runs the skill; verified 2026-11-03). Flags, *my call*, following the headless precedent in `src/main/services/prSummary.ts` where it fits: `--model <brain option, default sonnet>` (a per-brain option `model`: haiku, sonnet or opus; the token cap is in tokens, so the model sets what it means in EUR), `--permission-mode acceptEdits` with the brain's `.claude/settings.json` denying edits under `sources/`, `--strict-mcp-config` with an empty MCP config so no user MCP server sees brain content, `CLAUDE_CODE_DISABLE_CLAUDE_MDS` unset (the brain has no `CLAUDE.md`; the skills read `SCHEMA.md`), and sessions **kept** (no `--no-session-persistence`), since resume is a feature. Why headless rather than typing into the terminal: Shellie needs to know when a job ends to run lint and the next queued job, and hooks are out. The JSON result gives the session id, the result text and the usage; Shellie keeps the session id in `state.json`.

Because the article's capture is interactive ("read, discuss takeaways"), the Brain screen shows each finished capture's takeaways with **Continue in terminal**, which opens the brain terminal with `claude --resume <session id>` so the user can push back ("also link this to the reporting scope page"). The interactive brain terminal is also where **Ask** sends a question.

Rules:

- One job per brain at a time, in order: queued captures oldest first, then the lint that follows each capture, then sync or digest. `brain/lock` holds pid and timestamp; a lock older than an hour, or whose pid is gone, is stale and removed.
- Automatic: conversion on drop; mirror refresh (task start, daily, button); capture right after conversion; lint after every capture; the `log.md` line at task close (written by Shellie, no LLM).
- Optional per brain: `/sync` after a refresh that changed pages; `/digest` on Monday morning, or the next time the app is open after it (and never while another job runs).
- The daily token cap stops jobs from *starting*; it never kills a running one. Usage counted is the brain's ledger total for the day. When hit, the queue pauses and Health says so.
- A job that fails (non-zero exit, no JSON, error result) is shown in the inbox row with its message and can be retried; the source stays in `sources/`.

### Brain terminals and cost

Terminals belong to tasks today (`TerminalDef` on a task; `SHELLIE_TASK_ID` in the environment; usage receiver tags by `shellie.task.id`). Add a second owner: a brain. **Every brain terminal is brain-owned** (decided): one interactive terminal per brain, persisted on the brain in `brains.json`, not in `Task.terminals`; opening it from a task's "+" menu shows that same terminal in the task's tab bar; it is not restored or killed with the task and survives Finish. Its usage, including Ask, goes to the brain and is never invoiced. *My call on the mechanism:* keep one `TerminalManager`, give spawn options an `owner: { kind: 'task' | 'brain', id }`, set `SHELLIE_TASK_ID` to `brain:<id>` for brain terminals and headless jobs so the OTel path stays unchanged, and let attribution recognise the prefix. The builder may choose another shape if it fits the terminal restore/restart code better.

`Attribution` gets a fourth variant: `{ level: 'brain', brainId, organization, project }`, ranked with `task`. Records attributed to a brain are `billable: false` and are excluded by `LedgerStore.dirty()` (so the cost sender never sees them) and from invoicing views; the Usage screen shows them per brain. A task's Claude session reading brain pages through `--add-dir` is attributed to the task as now, so the customer pays for that reading. Decided.

### In a task

- **Brain tab** (read): beside Docs and Changes when the task has a brain. The Docs tab's markdown viewer, pointed at the brain's `index.md` and `wiki/`, with search over page titles and summaries. Cost: none.
- **Brain terminal** (write): in the "+" menu: the brain's own `claude` terminal (brain folder as working directory, so the skills load), shown in this task's tab bar. Not opened by default; `openBrainTerminalOnStart` shows it. Closing the tab hides it from the task; the terminal belongs to the brain.
- **Setup step** "Brain context", after `task.md` is written: refresh the mirror (8 s limit, like the work item fetch), then append to `task.md`:

  ```
  ## Context: <brain name>
  The project's brain is at <path>. Read-only for this task: read pages, do not edit them.
  (first 150 lines of index.md; "… N more in index.md" when cut)
  ```

  and add `--add-dir <path>` to the task's Claude terminal command. The New task and Setup screens show the step like the other steps (settings redesign, 2026-11-02).
- **At close**: Shellie appends `- <timestamp> task #<work item> closed: <title> (<PR link or branch>)` to `log.md` and commits. The **Finish** screen (not Done: finishing removes the worktree and `task.md` with it) has an option "Capture task.md into the brain", off by default, which copies `task.md` to `sources/tasks/<id>-task.md` before the worktree goes and queues a capture. *My call*: the Finish screen already carries the task's closing options, and asking there keeps the curator rule without Shellie keeping copies of `task.md` it was never asked to keep.

### The Brain screen

One left-nav entry per brain, under its connection. Sections: **Inbox** (drop zone and paste box; one row per source with conversion state, queue state, job result, retry, "Continue in terminal"), **Health** (last lint and its findings, each with "Resolve in terminal" which opens the brain terminal with the finding as the prompt; sources never captured; mirror freshness; outside edits; queue paused by cap), **Sources**, **Wiki** (the same viewer as the tab), **Log** (`log.md`), and the brain terminal. Buttons: Refresh wiki, Lint, Digest, Ask.

Settings › Connections › (connection) › **Brains**: the list, Create (name, folder, project, wiki and root page), per-brain options, Update skills, Delete (removes the entry; asks whether to delete the folder; ledger records keep their attribution).

### Privacy and telemetry

Brain names, paths, source file names and any content are scrubbed like repo and task names. Events to add to `docs/telemetry.md`: `brain.created` (wiki: yes/no), `brain.source.added` (content type, format, size bucket, conversion outcome), `brain.job` (skill, duration, outcome, headless/terminal), `brain.refresh` (duration, pages count bucket, outcome). Nothing with text.

Sources may contain personal data (names in transcripts) and secrets said aloud. The schema keeps them out of `wiki/`; `sources/` is a local folder and is stated as such on the Brain screen. No scrubbing of source content in phase 1.

### Windows

Conversion uses pure Node libraries (`mammoth` for DOCX, a zip plus XML reader for PPTX, `pdfjs-dist` or `pdf-parse` for PDF; builder's choice, must run in the Electron main process without native modules). Git calls go through the existing `GitClient`. Paths under `userData` keep the brain folder short because of path length limits. Not run on Windows in phase 1; noted as a gap in the change note.

## Verified on 2026-11-03

- `claude -p "/skill"` runs a skill from the folder's `.claude/skills/` (Haiku, one turn).
- `CLAUDE.md` in an `--add-dir` folder is not loaded.
- `git ls-remote` against the project's main repo authenticates with the PAT as an `http.extraheader` Basic header; `GIT_ASKPASS` did not. Shellie's `gitAuth.ts` already uses the header form through the environment.
- `.shellie/task.md` is excluded from git through `.git/info/exclude`, so the Context section never lands in the customer's repo.
- The test project `unreliablewitness/Shellie` has no wiki yet (`_apis/wiki/wikis` returns 0), so the wiki clone and page-tree calls are unverified until one is created.

## Left to the builder

- The exact conversion libraries and their handling of tables, footnotes and images (dropped, with a note in the source file).
- The page-tree picker's shape (tree with lazy loading, or a flat path list).
- How the terminal owner is modelled and restored across restarts.
- The wording and layout of the Brain tab and screen; the mockups in `design/mockups/` set the style.
- The first version of `SCHEMA.md` and the four skills, checked against a fixture brain (three sources: a SOW PDF, a VTT transcript, a wiki page) with a checklist: pages created with frontmatter and citations, index updated, log entry present, lint reports a seeded contradiction. This is the only test of skill quality in phase 1.

## Later phases (not designed)

Sharing (remote), publishing `wiki/` back to Azure DevOps as a code wiki or under a root page, work item attachments as a source, OCR, skills for other agents, scrubbing of source content.
