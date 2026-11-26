# A guided Brain tab in a task

Date: 2026-11-26, branch `feat/guided-brain-tab`. Asked by the owner in a session: the "<name> brain" tab in a task
was a bare agent terminal, "its an empty terminal its confusing. Can we have a bespoke view that guides a user?"
Spec `docs/superpowers/specs/2026-11-26-guided-brain-tab-design.md`, plan
`docs/superpowers/plans/2026-11-26-guided-brain-tab.md`, mockups on the design canvas the spec links (the owner
picked direction A, and "open from the start" for the tab).

![The Brain tab's start](assets/2026-11-26-guided-brain-tab/start.png)
![An answer in the tab](assets/2026-11-26-guided-brain-tab/answer.png)

## What changed

- **The Brain tab is a guide.** A head says what a brain is and names the task's work item, then three steps:
  1. **Ask**: a question field that is always there, three suggested questions, and a line on what asking costs.
  2. **Read what applies**: the long reads for the work item and the pages that mention the task, the search, and
     every page behind "All pages (n)".
  3. **Add what you learn**: drop a file anywhere on the tab, "Choose files", or "Write a note" (the brain's Add
     view).

  A foot link opens the brain's terminal.
- **Answers show in the tab.** A question runs the brain's agent in the background; the answer is rendered with
  the pages and sources it names as links and as cards ("Where this comes from"), how long it took, and the cost
  once the ledger has it. Follow-ups continue the same session and stack under each other. "Copy", "Continue in
  the terminal" and, when the task has an agent tab, "Send to this task's agent".
- **The Brain tab is in a task's tab row from the start**, not selected, for a ready task with a brain. Closed, it
  stays closed for the session until "Show brain" brings it back. It is the only view tab that is there unasked.
- **The brain terminal never opens by itself.** The brain option "Open the brain terminal when a task starts" left
  Settings; its stored key (`openBrainTerminalOnStart`) still parses and is ignored. The terminal's tab is now
  labelled "<name> brain terminal".

## How it works

- `src/main/brain/ask.ts`, `BrainAsks`: a headless run of the brain's agent in the brain's folder with the
  terminal's own prompt (`askPrompt`), outside the job queue and without the brain's lock, one per task, 3 minutes
  at most, stoppable. It is refused at the brain's daily token cap and while the brain's jobs are held (skills too
  old for its agent, or newer than this Shellie), with the reason. Usage lands on the brain (`brainJobEnv`).
- **Read-only is enforced, not asked for.**
  - Claude Code gets `--tools Read,Glob,Grep`: it has no other tool.
  - OpenCode gets a plain message, never `--command ask`: OpenCode puts a command's argument through its
    template, where a shell snippet in the question or the work item's title runs in the shell and `@path` attaches
    a file, whatever the permissions say.
  - OpenCode also gets an inline config that denies every edit and every command and takes the web search, code
    search and subagent tools away. OpenCode merges that with every other config it loads, where a rule for a
    narrower pattern wins over `*`, so every pattern those configs name is denied by name: Shellie's brain rules,
    the brain's own files and the person's global config, agents' rules included (`askOpencodePermission`,
    `opencodeConfigFiles`, `opencodeRulePatterns`). A config that is there but cannot be read refuses the question.
  - Both agents: the brain folder's commit and uncommitted changes are compared before and after. The answer's
    foot says "nothing was changed in the brain" only when they are the same, else that the folder changed.
- `brain:ask` adds one sentence naming the task's work item to the question (`askWithContext`), so "this" in a
  suggestion means something. `brain:askStop` stops the task's run.
- The thread lives in the renderer's store (`brainAsksByTask`, `askBrain`), so an answer lands while another tab
  or task shows. It is kept for the session and dropped with its task.
- `src/shared/brainAsk.ts`: `citedPaths` finds the `wiki/…` and `sources/…` paths an answer names, `linkCited`
  makes the ones that exist links, outside code blocks and links the agent wrote itself. A path that leaves the
  brain is never a link or a card. The ask skill did not
  change: no numbered markers, no new skills version.
- **Send to the agent** (`src/main/brain/sendAnswer.ts`, `brain:sendAnswer`): the question and answer go to
  `.shellie/brain-answer-<n>.md` in the agent tab's own folder, and one line naming the file is typed into the
  tab's prompt without Enter. Only into a running, unpaused agent tab that waits at an empty prompt
  (`pickSendTab` in `src/main/prDraft/pickTab.ts`: the pull request draft's rule without its one-hour limit); else
  the tab says why and nothing is written. The typed line counts as text in the prompt (tab activity), so nothing
  else is typed over it, and control characters in the question never reach the terminal. The pull request draft and this share how the task's agent tabs are
  read (`agentTabs` in `handlers.ts`).
- The amount in an answer's foot is what the brain's requests cost since the question started
  (`brainCostSince`): cost records carry no session id.

## Verified

- Unit tests for the helpers, the runner, the handlers, the store, the answer view, the tab and the tab row; the
  full suite passed (6100 tests) before the OpenCode fix below, and again after it.
- **The real app** on scratch data, both themes: the tab in the row from the start with the terminal still
  selected, the start, an answer with its cards, a page opened from an answer and Back, Back to the start and
  "Show the answers".
- **Real questions through the app**, with a question that also told the agent to create a file and run a command:
  - Claude Code (Sonnet), a first question and a follow-up on the same session: answered from the pages, cited
    them, wrote nothing, `git status` in the brain clean.
  - OpenCode (`opencode/big-pickle`): answered, cited the pages, wrote nothing.
- **OpenCode could not have written or run anything.** Asked directly, with the app's exact arguments and config,
  to write, edit and run `git status`, `git log`, `ls` and `mkdir`: every one was refused. These checks and the
  whole-branch review found three real holes, all closed and checked again on OpenCode 1.19.3:
  - with only `*` denied, `git status` still ran (the brain's own rule won); switching tools off in the config
    changed nothing;
  - through `--command ask`, a shell snippet in the question created a file (the reviewer read it in OpenCode's
    code, a live run confirmed it). With a plain message, the same snippet in the question and in the work item's
    title did nothing;
  - web search and subagents were available; with the three extra denies the agent reports it has neither.
- Claude Code with the same shell snippet in the question: nothing ran.

## Known gaps

- Windows: unit tests only.
- "Send to this task's agent" was not run in the real app (the scratch task had no agent tab); its rules and the
  typed line are covered by tests.
- "Continue in the terminal" and Stop were not clicked in the real app.
- **Not from this change, found by its review:** the brain's jobs on OpenCode still pass their input (a source's
  path, a conflict's answer) through `--command`, so a shell snippet in a dropped file's name could run there.
  Worth its own fix.
- The folder check cannot tell a question's change from a job's or a person's at the same moment, and sees only
  the brain's folder.
- The brain's agent changed between two questions of one thread: the follow-up asks the new agent to resume the
  other agent's session, which fails with a message; "Try again" then starts fresh only after the thread is gone
  (a restart).
- The cost in an answer's foot is usually missing right after the answer (the ledger gets its records a little
  later) and can include a job that ran at the same moment.
- Answers are lost on restart. Long reads still open on the Brain screen, not in the tab.
- Claude Code's first run in a scratch brain under `/private/tmp` reported that reading `index.md` by path failed
  and used search instead; not seen in the app's own run.
