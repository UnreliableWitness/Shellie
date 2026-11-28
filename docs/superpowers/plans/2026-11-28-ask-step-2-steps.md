# One ask everywhere, step 2: the agent's steps, and answers written out

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While an ask runs you see what the agent is doing, and a brain answer on Claude Code is written out as
it comes.

**Architecture:** `runWithInput` hands each line of standard output to an `onLine` callback; the pty host sends
those lines to main in batches. Pure readers turn a line of Claude Code's or OpenCode's event stream into a step
or a piece of text. Main sends `ask:progress` to the renderer; the shared ask parts draw it.

**Tech Stack:** Node child processes, Electron utility process, React, zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-28-ask-everywhere-design.md`, section "Steps and writing out".

## Global Constraints

- No guard of either run changes. The brain's tool list and permissions stay; only `--output-format` changes
  from `json` to `stream-json --verbose --include-partial-messages`.
- A step is `{ kind: 'read' | 'search' | 'edit' | 'write' | 'other'; label: string }`. Labels are words, no raw
  tool output, no thinking. Paths are relative to the run's folder; a path outside it is "a file outside the
  folder". At most 40 steps are kept; older ones are counted.
- `ask:progress` at most four times a second per run. Progress is never saved; the final steps are.
- An agent whose lines cannot be read still works: time and Stop, no steps.
- Event shapes, seen on 2026-11-28:
  - OpenCode 1.19.3 `run --format json`: `{"type":"tool_use","part":{"tool":"read","state":{"status":"completed","input":{"filePath":"…"}}}}`
    only when a tool finished; `{"type":"text","part":{"text":"…"}}` once, whole.
  - Claude Code `-p --output-format stream-json --verbose --include-partial-messages`:
    `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"…"}}]}}`
    when a tool is called; `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}`
    for text; a last `{"type":"result","subtype":"success","result":"…","session_id":"…"}`.

## Review Focus

- A line longer than a megabyte, or a chunk that ends in the middle of a multi-byte character: no crash, no
  garbled label.
- A run that prints thousands of events: the renderer gets at most four updates a second.
- Stop pressed while batches are still arriving: nothing is shown for a run that ended.
- A path with `..` or an absolute path outside the folder in a tool's input: never shown.
- Two asks running at once (a task's and another task's): each shows its own steps.

---

### Task 1: Lines out of a run

**Files:** `src/main/services/prSummary.ts` (`runWithInput`), `src/main/ptyHost/protocol.ts`, `host.ts`,
`client.ts`, and their tests.

**Produces:** `runWithInput(cmd, { …, onLine?: (line: string) => void })`: called for each complete line (no
trailing `\r`), also after the 4 MB collection cap, the last unterminated line at close; a line is cut at
65 536 characters. Protocol: `ToHost` `run` gains `lines?: true`; `FromHost` gains
`{ t: 'runLines'; n: number; lines: string[] }`, flushed every 250 ms and before `ran` / `runError`.
`PtyHostClient.run` passes `o.onLine` through.

- [ ] Tests: a child that prints `a\nb` in odd chunks (including one split inside a multi-byte character)
  gives `['a…','b']` in order; the unterminated tail arrives at close; no `onLine` means no behaviour change;
  host: a run with `lines` posts `runLines` before `ran`; client: `runLines` reaches `onLine`, and none after
  the run settled.
- [ ] Implement (a `StringDecoder` for the chunks). Run `npx vitest run src/main/services/prSummary.test.ts
  src/main/ptyHost`. Commit.

### Task 2: Reading the agents' events

**Files:** create `src/shared/askProgress.ts` (types), `src/main/ask/steps.ts`, `src/main/ask/steps.test.ts`.

**Produces:**

```ts
// shared/askProgress.ts
export type AskStep = { kind: 'read' | 'search' | 'edit' | 'write' | 'other'; label: string };
export type AskProgress = { steps: AskStep[]; earlier: number; text: string };
export const ASK_STEPS_MAX = 40;
// main/ask/steps.ts
export function opencodeStep(line: string, cwd: string): AskStep | null;
export function claudeEvent(line: string, cwd: string): { step?: AskStep; text?: string; reset?: true } | null;
export function claudeStreamResult(stdout: string): { result: string; sessionId: string | null };
export function progressLog(emit: (p: AskProgress) => void, o?: { everyMs?: number; now?: () => number }):
  { step(s: AskStep): void; text(t: string): void; resetText(): void; flush(): void; snapshot(): AskProgress };
```

Labels: read → "Read <path>"; grep/search → "Searched for “<pattern>”"; glob/list → "Looked for <pattern>";
edit → "Edited <path>"; write → "Wrote <path>"; anything else → "Used <tool>" (`other`). A pattern is cut at 60
characters. `claudeEvent` returns `reset` with a tool step (text before a tool call is not the answer).
`claudeStreamResult` finds the last `result` line and applies `claudeResultWithSession`'s rules to it.
`progressLog` collapses a step equal to the last one, keeps the newest 40 and counts the rest in `earlier`, and
emits at most once per `everyMs` (250) with a trailing emit.

- [ ] Tests with the shapes above, plus: a path outside `cwd`, a `..` path, a non-JSON line (null), an unknown
  tool, 45 steps (40 kept, `earlier` 5), two equal steps (one), ten `text` calls within 250 ms (two emits).
- [ ] Implement. Commit.

### Task 3: The brain's ask sends progress

**Files:** `src/main/brain/ask.ts` (+ test), `src/shared/brainAsk.ts` (`BrainAnswer.steps?: AskStep[]`,
`pagesRead?: number`), `src/shared/ipc.ts` (event `ask:progress: { key: string } & AskProgress`), the place
`BrainAsks` is constructed (pass `progress`), `src/renderer/store.ts` (`askProgress: Record<string, AskProgress>`,
set on the event, cleared when the exchange ends), where renderer events are subscribed.

- [ ] Tests: Claude flags are `stream-json`, `--verbose`, `--include-partial-messages`; a run whose lines are
  fed through `onLine` calls `progress(key, …)` with the steps and text and resolves with `steps` and
  `pagesRead` (distinct read labels); OpenCode the same from its lines; a run with unreadable lines resolves as
  today with no steps.
- [ ] Implement; key `brain:<taskId>`. Commit.

### Task 4: The dream's ask sends progress

**Files:** `src/main/dreams/dreamRun.ts` (`dreamCall` gains `onLine`), `dreamHandlers.ts` (`runAsk` builds a
`progressLog`, key `dream:<repoId>`; the row gains `steps`), `src/shared/dreams.ts` (`steps` optional on the
adjustment), tests.

- [ ] Tests: an ask whose run prints OpenCode tool lines emits progress and stores `steps` on its row (changed,
  answer, stopped and failed alike). Implement. Commit.

### Task 5: Drawing it

**Files:** `src/renderer/components/ask/AskSteps.tsx` (+ test), `AskRows.tsx` (`AskWorking` takes `progress?`),
`DreamAsk.tsx`, `BrainAnswers.tsx`, `ask.css`.

**Produces:** `AskSteps({ steps, earlier })`: an unlabelled list, monospace, a tick per step, "N earlier steps"
first when `earlier > 0`. `AskWorking` shows the steps above its time line, and for the brain the text so far as
Markdown under them. A finished row's foot gains "N steps" (dream) or "read N pages" (brain); the steps of a
finished ask unfold from that foot ("Show the steps").

- [ ] Tests: steps render in order with the earlier line; the partial text shows; the foot words; no steps, no
  list. Implement. Run the renderer suite, typecheck, lint. Commit.

### Task 6: The change note, the app, the review

- [ ] In the running app (free OpenCode model): a brain question and a dream ask show steps as they finish.
  A Claude Code brain question is the owner's subscription: one short Haiku question to see text written out.
- [ ] `docs/changes/2026-11-28-ask-steps.md`. Whole-branch review. Pull request, merge on green, release.
