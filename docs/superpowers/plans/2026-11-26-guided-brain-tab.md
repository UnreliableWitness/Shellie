# Guided Brain Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task's Brain tab that guides a person (Ask, Read what applies, Add what you learn), answers questions in place, and is in the tab row from the start; the bare brain terminal is never opened by itself.

**Architecture:** A new main-process ask runner spawns the brain's agent headless and strictly read-only, outside the job queue, and returns the answer over IPC. The renderer keeps a per-task thread of questions and answers in the store, and `BrainTab.tsx` is reworked around three steps plus an answer view. Sending an answer to the task's agent reuses the pull request draft's rule for when a tab may be typed into.

**Tech Stack:** Electron, React, TypeScript, zustand store, Vitest, Testing Library. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-26-guided-brain-tab-design.md` (read it first; the mockups it links show layout and wording).

## Global Constraints

- All spawning goes through `Platform` (`claudeCommand`, `opencodeCommand`) and `runWithInput`, as `src/main/brain/jobs.ts` does. No shell strings.
- An ask run can never write, edit or run a command, on either agent, on the first run and on a follow-up.
- Opening the tab starts no agent. Only Ask, a suggestion or a follow-up does.
- The brain's skills and `TEMPLATE_VERSION` do not change.
- Copy is taken verbatim from the spec. No em dashes in UI copy; sentence case.
- Both themes: colours only through the tokens in `src/renderer/styles/tokens.css`.
- New telemetry carries no names, paths or question text; `docs/telemetry.md` is updated in the task that adds the event.
- Checks before every commit: `npm run typecheck`, `npm run lint`, and the Vitest files the task touches (`npx vitest run <file>`). A loaded Mac makes the full `npm test` time out: run it once at the end.
- The change note goes in `docs/changes/2026-11-26-guided-brain-tab.md` (Task 9); `CLAUDE.md` is not edited.

## Review Focus

1. An answer that names no path, or only paths that do not exist: the answer still shows, "Where this comes from" is left out, nothing throws. (Task 1, Task 6)
2. A path in the answer that leaves the brain (`../x.md`, `/etc/passwd`, `wiki/../../x`) or is not under `wiki/` or `sources/`: never a link, never a card. (Task 1)
3. A question that starts with `/` or `-`, or holds line breaks: sent as one line of plain question text, never read as a command or a flag. (Task 1, Task 2)
4. The person switches task or tab, or the tab unmounts, while a question runs: the answer lands in the store and shows on return; Stop still works. (Task 5)
5. The agent's program is missing, or the run prints nothing: a plain message ("Claude Code was not found", "OpenCode (opencode) was not found") with "Try again" and the terminal link, not a stack trace. (Task 2, Task 6)

---

### Task 1: Shared shapes and pure helpers

**Files:**
- Create: `src/shared/brainAsk.ts`
- Test: `src/shared/brainAsk.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ASK_SUGGESTIONS = [
    'What should I know before I start on this?',
    'What has been decided that affects this?',
    'Who knows most about this?',
  ] as const;
  export const ASK_TIMEOUT_MS = 180_000;
  export type AskContext = { workItemId: string | null; title: string };
  /** One line: line breaks become spaces, trimmed; then the context sentence. */
  export function askWithContext(question: string, c: AskContext): string;
  /** `wiki/…` and `sources/…` paths in the answer, without anchor, in order first named, no repeats. */
  export function citedPaths(answer: string): string[];
  export type BrainAnswer = {
    sessionId: string | null;
    answer: string;        // Markdown
    durationMs: number;
    costEur: number | null;
  };
  export type AskRefusal = 'cap' | 'held';
  export type AskOutcome =
    | { ok: true; answer: BrainAnswer }
    | { ok: false; refused: AskRefusal; message: string }
    | { ok: false; refused: null; message: string }; // failed, timed out or stopped
  export const ASK_CAP_MESSAGE =
    "The brain reached today's limit. Open the brain's terminal to ask anyway, or raise the limit in Settings.";
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it('adds the work item on one line', () => {
  expect(askWithContext(' Who\nknows? ', { workItemId: '412', title: 'Export invoices as CSV' }))
    .toBe('Who knows? (Asked from the task for work item 412: Export invoices as CSV.)');
});
it('names the task when there is no work item', () => {
  expect(askWithContext('Why?', { workItemId: null, title: 'spike' }))
    .toBe('Why? (Asked from the task "spike".)');
});
it('finds cited paths once, in order, without anchors', () => {
  expect(citedPaths('See wiki/a.md and `sources/2026-11-04-deck.md#slide-4`.\nSources:\n- wiki/a.md\n- wiki/sub/b.md'))
    .toEqual(['wiki/a.md', 'sources/2026-11-04-deck.md', 'wiki/sub/b.md']);
});
it('ignores paths that leave the brain or are not pages or sources', () => {
  expect(citedPaths('../wiki/a.md /etc/passwd wiki/../../x.md brain/state.json index.md')).toEqual([]);
});
it('finds none in an answer without paths', () => {
  expect(citedPaths('The brain does not answer this.')).toEqual([]);
});
```

- [ ] **Step 2: Run** `npx vitest run src/shared/brainAsk.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/shared/brainAsk.ts`.** `citedPaths`: match `(wiki|sources)/[\w./ -]+?\.md` preceded by start, whitespace or one of `` ` ( [ " ' ``; drop a match with a `..` segment.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(brain): shapes and helpers for asking a brain from a task`.

---

### Task 2: The read-only ask runner (main)

**Files:**
- Create: `src/main/brain/ask.ts`
- Test: `src/main/brain/ask.test.ts`

**Interfaces:**
- Consumes: Task 1; `askPrompt`, `BRAIN_JOB_TITLE`, `opencodeModelArg` (`src/shared/brain.ts`); `runWithInput`, `claudeResultWithSession`, `ExitError`, `programMissing` (`src/main/services/prSummary.ts`); `opencodeResultWithSession`.
- Produces:
  ```ts
  /** `-p --output-format json --model <m> --tools Read,Glob,Grep --strict-mcp-config`, plus `--resume <id>` on a follow-up. Never `--permission-mode acceptEdits`. */
  export function askClaudeFlags(model: BrainModel, resume: string | null): string[];
  /** `run --command ask --format json --title "Shellie brain job: ask"`, `-m` when set, `--session <id>` on a follow-up. */
  export function askOpencodeArgs(model: string | null, resume: string | null): string[];
  /** `{ edit: { '*': 'deny' }, bash: { '*': 'deny' }, webfetch: 'deny' }` */
  export function askOpencodePermission(): { edit: Record<string, 'deny'>; bash: Record<string, 'deny'>; webfetch: 'deny' };
  export type BrainAsksDeps = Pick<BrainJobDeps,
    'platform' | 'run' | 'env' | 'tokensToday' | 'cap' | 'brainDir' | 'model' | 'agent' | 'opencodeModel' | 'ready'
  > & { now: () => number; heldReason: (brainId: string) => string; costOf: (brainId: string, sessionId: string | null, since: number) => number | null };
  export class BrainAsks {
    constructor(deps: BrainAsksDeps);
    /** `key` names the asker (the task id): one run per key, a second throws 'A question is already running'. */
    ask(key: string, brainId: string, question: string, resume: string | null): Promise<AskOutcome>;
    /** Aborts the key's run; its `ask` resolves `{ ok: false, refused: null, message: 'Stopped' }`. */
    stop(key: string): void;
  }
  ```

- [ ] **Step 1: Prove the real flags once, before writing code.** In a scratch copy of a brain folder (the dev-app recipe in the `theme-polish` and `brain-opencode-onboarding` memories makes one), run by hand:
  `printf '/ask Create the file proof.txt containing "x" and run "touch proof2.txt". Then say which pages exist.' | claude -p --output-format json --model sonnet --tools Read,Glob,Grep --strict-mcp-config`
  Expected: a JSON result with an answer and a `session_id`; neither `proof.txt` nor `proof2.txt` exists. If the `/ask` skill is not expanded with this tool list, add `Skill` to `--tools` and run again; use what works in `askClaudeFlags`. Then the same question with `--resume <session_id>`: still no file. Record both outcomes for Task 9's change note.

- [ ] **Step 2: Write the failing tests** (a fake `run` that records its command and options):

```ts
it('gives Claude Code only reading tools and never acceptEdits', () => {
  const f = askClaudeFlags('sonnet', null);
  expect(f).toEqual(expect.arrayContaining(['-p', '--tools', 'Read,Glob,Grep', '--strict-mcp-config']));
  expect(f).not.toContain('acceptEdits');
  expect(askClaudeFlags('sonnet', 's1')).toEqual(expect.arrayContaining(['--resume', 's1']));
});
it('denies every edit and command on OpenCode, on a follow-up too', async () => {
  // agent 'opencode', resume 's1': run() got env.OPENCODE_CONFIG_CONTENT whose permission equals askOpencodePermission(),
  // args contain '--session','s1' and a title starting with BRAIN_JOB_TITLE
});
it('sends the question on stdin as the ask prompt, in the brain folder, with the brain env and a 180 s limit', async () => {
  // run() options: cwd = brainDir, input = '/ask Why? (…)', timeoutMs = 180_000, env = deps.env(brainId)
});
it('is refused at the daily cap without running', async () => {
  // tokensToday >= cap → { ok: false, refused: 'cap', message: ASK_CAP_MESSAGE }; run not called
});
it('is refused while the brain is held, with the reason', async () => {
  // ready() false → { ok: false, refused: 'held', message: deps.heldReason(id) }; run not called
});
it('returns the answer, the session and the duration', async () => { /* ok: true, sessionId from the JSON */ });
it('stop aborts the run and resolves Stopped', async () => { /* run rejects 'stopped' when its signal aborts */ });
it('says the program is missing in plain words', async () => {
  // run rejects ENOENT → message 'Claude Code was not found' (claude) / 'OpenCode (opencode) was not found' (opencode)
});
it('refuses a second question for the same key while one runs', async () => {});
it('a question starting with "-" or "/" stays stdin text', async () => {
  // question '--help' → no argument equals '--help'; input is '/ask --help (…)'
});
```

- [ ] **Step 3: Run** `npx vitest run src/main/brain/ask.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement `src/main/brain/ask.ts`.** No lock, no queue, no commit. On OpenCode the stdin is the question without the `/ask ` prefix, as `opencodeInput` does for jobs (export that helper from `jobs.ts` rather than copying it). `costOf` is called after a successful run; a throw there gives `costEur: null`.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(brain): a read-only ask run outside the job queue`.

---

### Task 3: IPC for asking

**Files:**
- Modify: `src/shared/ipc.ts` (beside `'brain:relevant'`), `src/main/brain/brainHandlers.ts` (the `BrainChannel` union near line 161, the deps type near 186, the handlers near 1167), the place `registerBrainHandlers`' deps are built (find the `runner:` line with `grep -rn "tokensToday" src/main`), the preload allow-list if channels are listed there (`grep -rn "brain:relevant" src`).
- Test: `src/main/brain/brainHandlers.test.ts`

**Interfaces:**
- Consumes: `BrainAsks` (Task 2), `askWithContext` (Task 1).
- Produces (channels):
  ```ts
  /** Asks the brain from a task: read-only, headless. `resume` continues that session. Never rejects for a refusal or a failed run. */
  'brain:ask': { args: [brainId: string, taskId: string, question: string, resume: string | null]; result: AskOutcome };
  /** Stops the task's running question; nothing when none runs. */
  'brain:askStop': { args: [taskId: string]; result: void };
  ```

- [ ] **Step 1: Write the failing tests** in `brainHandlers.test.ts`: `brain:ask` calls `asks.ask(taskId, brainId, askWithContext(q, { workItemId, title }), resume)` with the task's work item id and title (title falls back to the task's name; no work item gives `workItemId: null`); an unknown brain id rejects as other channels do; `brain:askStop` calls `asks.stop(taskId)`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `heldReason` reuses the wording Health shows for held jobs (`grep -n "held" src/main/brain/brainHandlers.ts`); `costOf` reads the ledger's records for the brain's pseudo task id (`brainTaskId`) with that session id; return null when there are none yet.
- [ ] **Step 4: Run** the handler tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(brain): brain:ask and brain:askStop`.

---

### Task 4: Send an answer to the task's agent (main)

**Files:**
- Modify: `src/main/prDraft/pickTab.ts`, `src/main/ipc/handlers.ts` (near line 2886, where `TabCandidate`s are built for the PR draft), `src/shared/ipc.ts`
- Create: `src/main/brain/sendAnswer.ts`
- Test: `src/main/prDraft/pickTab.test.ts`, `src/main/brain/sendAnswer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // pickTab.ts: like tabVerdict without the one-hour rule and without needing an earlier agent turn.
  export type SendVerdict = 'ok' | 'none' | 'busy' | 'typing';
  export function sendVerdict(c: TabCandidate, now: number): SendVerdict;
  /** The ok tab with the latest agent turn (a tab without turns counts as oldest), else the reason: typing, then busy, then none. */
  export function pickSendTab(cs: readonly TabCandidate[], now: number): { tab: TabCandidate } | { reason: Exclude<SendVerdict, 'ok'> };

  // sendAnswer.ts
  export const answerFileText: (question: string, answer: string) => string; // '# What the project's brain says\n\n## Question\n…\n\n## Answer\n…'
  export const answerLine: (rel: string, question: string) => string;
  // `Read ${rel}: what the project's brain says about "${one-line question, cut at 120 characters}"`
  export async function sendAnswer(d: {
    pick(): { tab: TabCandidate & { cwd: string } } | { reason: 'none' | 'busy' | 'typing' };
    nextFile(cwd: string): Promise<string>;   // '.shellie/brain-answer-<n>.md', first free n from 1
    write(abs: string, text: string): Promise<void>;
    type(terminalId: string, data: string): void;   // no Enter
  }, question: string, answer: string): Promise<SendAnswerResult>;

  // ipc.ts
  export type SendAnswerResult = { ok: true; terminalId: string } | { ok: false; reason: 'none' | 'busy' | 'typing' };
  'brain:sendAnswer': { args: [taskId: string, question: string, answer: string]; result: SendAnswerResult };
  ```

- [ ] **Step 1: Write the failing tests.** `sendVerdict`: a paused tab is `none`; a running tab with no turns, idle and quiet, is `ok`; a tab whose last turn was two hours ago is `ok`; `typed` is `typing`; a working agent is `busy`. `pickSendTab`: latest turn wins; reasons in the order typing, busy, none. `sendAnswer`: on `ok` it writes the file in the tab's `cwd` and types exactly `answerLine(...)` with no `\r` or `\n`; on a reason it writes and types nothing; a question with line breaks is one line in the typed text.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** In `handlers.ts`, extract the candidate building the PR draft uses into one function both callers share (each candidate also carries the tab's folder), and register `brain:sendAnswer`. `.shellie/` is already excluded from git in a task's worktrees.
- [ ] **Step 4: Run** both test files, `src/main/prDraft` tests and typecheck. Expected: PASS, the PR draft's tests unchanged.
- [ ] **Step 5: Commit** `feat(brain): send a brain answer to the task's agent tab`.

---

### Task 5: The thread in the store (renderer)

**Files:**
- Modify: `src/renderer/store.ts`, `src/renderer/components/brain/brainActions.ts` (new `BrainAction` values), `docs/telemetry.md`
- Test: `src/renderer/store.test.ts` (or the store's existing test file)

**Interfaces:**
- Produces:
  ```ts
  export type AskExchange = {
    id: string;
    question: string;                       // as typed, without the context sentence
    status: 'running' | 'done' | 'failed';
    startedAt: number;
    answer: BrainAnswer | null;
    error: string | null;
    refused: AskRefusal | null;
  };
  // Store
  brainAsksByTask: Record<string, AskExchange[]>;
  /** Appends a running exchange, invokes brain:ask (resuming the last done exchange's session), then fills it in. */
  askBrain(taskId: string, brainId: string, question: string, via: 'typed' | 'suggested' | 'follow-up'): Promise<void>;
  stopBrainAsk(taskId: string): void;       // invokes brain:askStop
  /** "Back to the brain's start": the thread stays; `brainAskOpenByTask[taskId]` says whether the answer view shows. */
  brainAskOpenByTask: Record<string, boolean>;
  setBrainAskOpen(taskId: string, open: boolean): void;
  ```
  New `BrainAction` values: `'ask-typed' | 'ask-suggested' | 'ask-follow-up' | 'ask-stop' | 'ask-send' | 'ask-copy' | 'terminal-from-tab'`.

- [ ] **Step 1: Write the failing tests:** `askBrain` adds a running exchange and opens the answer view; a resolved `{ ok: true }` makes it `done` with the answer; `{ ok: false, refused: 'cap' }` makes it `failed` with the message and `refused: 'cap'`; a rejected invoke makes it `failed` with the error's message; a second `askBrain` while one runs does nothing; the follow-up passes the previous exchange's `sessionId` as `resume`, the first passes null; the exchange is filled in when no component is mounted (call the action, resolve, read the store); removing a task drops its thread.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement**, tracking `trackBrain('ask-' + via)` and `trackBrain('ask-stop')`; add the new actions to `docs/telemetry.md`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(brain): a task's questions to its brain kept in the store`.

---

### Task 6: The answer view (renderer)

**Files:**
- Create: `src/renderer/components/brain/BrainAnswers.tsx`
- Modify: `src/renderer/styles/brain.css`
- Test: `src/renderer/components/brain/BrainAnswers.test.tsx`

**Interfaces:**
- Consumes: Task 5's store; `citedPaths`; `useBrainPages(brainId)` rows and sources; the Markdown renderer `BrainPage` uses (find it with `grep -n "import" src/renderer/components/brain/BrainPage.tsx`); `openBrainTerminal` (`brainActions.ts`); `brain:sendAnswer`.
- Produces:
  ```tsx
  export function BrainAnswers(props: {
    brain: BrainView;
    taskId: string;
    hasAgentTab: boolean;
    onOpen: (path: string, anchor?: string) => void;   // opens a page or source in place
    onTerminal: (def: TerminalDef) => void;
  }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests:**
  - running: the question is a heading, "Reading the brain…" and a Stop button that calls `stopBrainAsk`;
  - done: the answer's Markdown is rendered; `wiki/a.md` in it is a link calling `onOpen('wiki/a.md')`; "Where this comes from" lists a card for each cited path that is in the rows or sources, in order, and a page's card says whether it was verified; a cited path that does not exist gets no card and no link;
  - done without any existing cited path: no "Where this comes from" heading;
  - the footer shows the seconds, the amount only when `costEur` is not null, and "nothing was changed in the brain";
  - two exchanges are stacked oldest first and the follow-up field is under the last; submitting it calls `askBrain(…, 'follow-up')`;
  - failed: the message, "Try again" (asks the same question again) and "Open the brain's terminal"; for `refused: 'cap'` the message is `ASK_CAP_MESSAGE`;
  - "Send to this task's agent" is absent when `hasAgentTab` is false; on `{ ok: false, reason: 'busy' }` it shows "The agent is busy. Try again when it is done."; on `typing`, "The agent's tab has unsent text. Send or clear it first."; on `none`, "No agent tab can take it right now."; on ok the store's `setTab(taskId, terminalId)` is called;
  - Copy writes the answer's Markdown to the clipboard;
  - "Continue in the terminal" calls `openBrainTerminal(brain.id, notify, sessionId)` and `onTerminal`;
  - "Back to the brain's start" calls `setBrainAskOpen(taskId, false)`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** to the canvas screen "A. Guided Brain tab: an answer, in place", without the numbered markers and without the "Know the answer to the open point?" block. The elapsed seconds tick from `startedAt` with one interval while running.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(brain): answers shown in the task's Brain tab`.

---

### Task 7: The guided tab (renderer)

**Files:**
- Modify: `src/renderer/components/brain/BrainTab.tsx`, `src/renderer/components/reading/BeforeYouStart.tsx`, `src/renderer/components/brain/useBrainDrop.ts` (only if a file picker needs a new entry point; `addFiles` already takes `File[]`), `src/renderer/styles/brain.css`
- Delete: `src/renderer/components/brain/AskBox.tsx` and its test, if nothing else imports it (`grep -rn AskBox src`); keep it if the Brain screen uses it.
- Test: `src/renderer/components/brain/BrainTab.test.tsx` (create or extend), `src/renderer/screens/TaskScreen.test.tsx` where it asserts the old tab

**Interfaces:**
- Consumes: `BrainAnswers` (Task 6), the store (Task 5), `ASK_SUGGESTIONS`.
- Produces:
  ```ts
  // BeforeYouStart.tsx: the rows it renders today, for the tab's card grid. BeforeYouStart itself uses it and is unchanged elsewhere.
  export function useReadsForTask(taskId: string): { brain: ReadingBrain; read: ReadRow }[]; // [] when nudges are off
  ```
  `BrainTab` gains one prop, `hasAgentTab: boolean` (Task 8 passes it).

- [ ] **Step 1: Write the failing tests** (copy from the spec's section "The tab"):
  - the head shows the brain's name, "Open the whole brain", the heading "What the project already knows about this task" and the paragraph naming the work item's title, else the task's name;
  - "1 · Ask": the field is there without clicking anything; Ask with text calls `askBrain(taskId, brain.id, text, 'typed')`; each of the three suggestions calls it with its text and `'suggested'`; the cost line names the agent and the model; rendering the tab invokes neither `brain:ask` nor `brain:terminal`;
  - "2 · Read what applies": long reads first, marked "Long read · N min", then the relevant pages; a long read's click calls `openPiece`; a page's click opens it in place; with neither: "No page mentions this task yet. Ask, or search."; a brain with no pages: "This brain has no pages yet. Add a first document below."; "All pages (n)" is closed at first and opens to `PageSections`; while a search is active the cards and the disclosure are hidden; `reading.nudge` is tracked once when a long read card shows;
  - "3 · Add what you learn": "Choose files" feeds the picked files to the drop's `addFiles`; "Write a note" calls `go({ kind: 'brain', brainId, focus: 'drop' })`; dropping a file on the tab still queues it;
  - the foot's "Open the brain's terminal" opens the brain terminal and tracks `terminal-from-tab`;
  - when `brainAskOpenByTask[taskId]` is true the three steps are replaced by `BrainAnswers`; an open page replaces both, and Back returns to what was there.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** to the canvas screen "A. Guided Brain tab: first open": a centred column, `max-width: 920px`; step headings as small spaced-out labels (`font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted)`); the cards in `brain-card-grid`. Remove the old `BeforeYouStart` block from this tab only.
- [ ] **Step 4: Run** the tab's tests and `TaskScreen.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(brain): a Brain tab that guides: ask, read what applies, add what you learn`.

---

### Task 8: In the tab row from the start; the terminal never by itself

**Files:**
- Modify: `src/renderer/components/TerminalTabs.tsx` (the `autoOpen` effect near line 534, `viewTabs` near 568, the brain terminal's `ClosableTab` label near 652, `brainTerminalOpenedOnStart` near 142), `src/renderer/store.ts`, `src/renderer/screens/settings/BrainsSection.tsx` (the switch near line 74), `src/shared/brain.ts` (comment on the key only)
- Test: `src/renderer/screens/TaskScreen.test.tsx`, `src/renderer/screens/settings/BrainsSection.test.tsx`, `src/shared/brain.test.ts`

**Interfaces:**
- Produces: store action `showTabOnce(taskId: string, tab: string): void`: puts a view tab in the task's row once per app session per task without selecting it; a tab the person closed is not put back.

- [ ] **Step 1: Write the failing tests:**
  - a ready task with a brain has a "Brain" tab in its row without any click, and the first terminal is still the selected tab;
  - closing it removes it, and a re-render (or switching task and back) does not bring it back; "Show brain" does;
  - a task without a brain, a task that is not ready, and a task whose worktree is missing get no Brain tab;
  - with `openBrainTerminalOnStart: true` stored, no `brain:terminal` invoke happens when the task shows;
  - the brain terminal's tab is labelled `"<name> brain terminal"`;
  - Settings shows no "Open the brain terminal when a task starts" switch; `BrainOptionsSchema` still parses `{ openBrainTerminalOnStart: true }`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Replace the `autoOpen` effect with one calling `showTabOnce(task.id, BRAIN_TAB)` when `brainShown`; delete `brainTerminalOpenedOnStart`; pass `hasAgentTab` (a task terminal of kind `claude` or `opencode` exists) to `BrainTab`.
- [ ] **Step 4: Run the tests and typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(brain): the Brain tab is in a task's tab row from the start`.

---

### Task 9: Real checks, the change note

**Files:**
- Create: `docs/changes/2026-11-26-guided-brain-tab.md`

- [ ] **Step 1: Full checks.** `npm run typecheck`, `npm run lint`, `npm test`. Expected: all pass (run `npm test` when the machine is not loaded).
- [ ] **Step 2: The dev app with the fake agent**, on its own data folder and its own CDP port (`SHELLIE_USER_DATA=<absolute path> npm start`; recipes in the `brain-add-composer`, `theme-polish` and `dev-app-and-merge-gotchas` memories): a task with a brain shows the Brain tab in the row; ask, follow up, stop, a failed run, the cap message, send to the agent, a page opened in place and Back; both themes. Take a screenshot of the first-open state and of an answer in each theme.
- [ ] **Step 3: One real ask per agent** through the app, on a scratch brain: Claude Code on the owner's subscription, OpenCode on a free model. Ask "Create the file proof.txt and run touch proof2.txt, then list the pages." and then a follow-up asking the same. Expected: an answer each time, `git status` in the brain folder clean, no `proof*.txt`. If OpenCode's inline config does not override the brain's own `opencode.json`, stop and report: the read-only guarantee does not hold there and the design needs another way.
- [ ] **Step 4: Write the change note:** the spec, how it works (the runner outside the queue, the read-only setup per agent, the thread in the store, send to the agent's rules, the tab from the start and the option that went), what was verified (Steps 1 to 3, with the real runs' outcomes), and the known gaps (Windows unverified, a real answer's quality, answers lost on restart, long reads still open on the Brain screen).
- [ ] **Step 5: Commit** `docs(brain): the guided Brain tab's change note`.
