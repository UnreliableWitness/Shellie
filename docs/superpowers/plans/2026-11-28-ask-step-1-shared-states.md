# One ask everywhere, step 1: shared parts and the five states

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dream's ask and the task's brain ask are drawn by the same components, with the same five states
and the same words; a stop is a stop, and "Ask again" / "Try again" run at once.

**Architecture:** New renderer folder `src/renderer/components/ask/` holds the composer and the state rows. The
dream's run (`dream:adjust`) and the brain's (`brain:ask`) keep their engines; each gains only the data a
"Stopped" row needs. The two `AskBox` components and their CSS go.

**Tech Stack:** React, TypeScript, zustand, zod, Vitest + Testing Library. Format with `oxfmt`.

**Spec:** `docs/superpowers/specs/2026-11-28-ask-everywhere-design.md` (this plan is its "Order of building",
step 1; steps 2 to 6 get their own plans).

## Global Constraints

- No guard of either run changes: the brain's tools and permissions (`src/main/brain/ask.ts`), the dream's
  worktree rules and model rule (`src/main/dreams/dreamHandlers.ts`).
- Words: "Ask" sends, "Stop", "Ask again" after a stop, "Try again" after a failure. No "Retry".
- Stopped is not an alert: no `role="alert"`, no red, no amber.
- Old data loads: every new schema field is optional; a dream result with `adjustFailed` still shows it.
- No telemetry carries question or answer text. Existing event names stay.
- Not in this step: steps and streamed text, kept brain threads, the Ask view, memory, per-ask diff, redo, the
  queue, done-elsewhere signals, Mod+L, Stop on jobs.

## Review Focus

- Enter pressed while a run is under way: the typed text stays in the box, nothing is sent.
- "Ask again" clicked twice quickly: one run starts.
- A dream result saved by an older version (an `adjustFailed`, adjustments without `outcome`): renders as before.
- Stop pressed, then the page left and reopened: the Stopped row is still there with its time (dream).
- A very long ask or note (4 000 / 1 000 characters, no spaces): wraps inside the pane, no sideways scroll.

---

### Task 1: The shared parts

**Files:**
- Create: `src/renderer/components/ask/AskComposer.tsx`, `AskRows.tsx`, `askWords.ts`, `index.ts`
- Create: `src/renderer/styles/ask.css` (imported where the other style sheets are)
- Test: `src/renderer/components/ask/AskComposer.test.tsx`, `AskRows.test.tsx`, `askWords.test.ts`

**Interfaces (produces):**

```ts
// askWords.ts
/** "18 s", "1 min 12 s", "2 min" (no seconds from ten minutes on). */
export function tookWords(ms: number): string;
export const ASK_HINT = 'Enter sends · Shift+Enter starts a new line';

// AskComposer.tsx
export function AskComposer(props: {
  value: string;
  onChange(next: string): void;
  onSend(): void;
  label: string;            // aria-label and placeholder
  hint?: string | null;     // shown under an empty box
  quote?: string | null;    // the About chip
  onQuoteRemove?(): void;
  off?: string | null;      // why the box is disabled; shown under it
  waiting?: string | null;  // a run is under way: box usable, Ask disabled, this sentence under it
  sending?: boolean;        // the send call is in flight: read-only
  maxLength?: number;
  primary?: boolean;        // the button is the page's primary one
  boxRef?: React.Ref<HTMLTextAreaElement>;
  boxProps?: Pick<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onMouseDown' | 'onFocus'>;
}): JSX.Element;

// AskRows.tsx
export function Elapsed(props: { startedAt: number }): JSX.Element;      // moved from BrainAnswers
export function AskWorking(props: {
  word: 'Working' | 'Answering'; startedAt: number; onStop(): void; stopOff?: boolean;
  focusRef?: React.Ref<HTMLParagraphElement>;
}): JSX.Element;                                                          // role="status"
export function AskStopped(props: {
  afterMs: number | null; onAgain(): void; againOff?: boolean;
}): JSX.Element;      // "Stopped after 18 s. Nothing was changed." / "Stopped. Nothing was changed." + "Ask again"
export function AskFailed(props: {
  reason: string; onRetry(): void; retryOff?: boolean;
  second?: { label: string; run(): void };
}): JSX.Element;      // role="alert", "Could not finish." in bold then the reason, "Try again" primary
export function AskFoot(props: { parts: (string | null | false)[] }): JSX.Element | null; // joined with " · "
```

- [ ] **Step 1:** Write `askWords.test.ts`: `tookWords(18_400) === '18 s'`, `tookWords(72_000) === '1 min 12 s'`,
  `tookWords(120_000) === '2 min'`, `tookWords(640_000) === '11 min'`, `tookWords(400) === '1 s'`.
- [ ] **Step 2:** Write `AskComposer.test.tsx`:
  - Enter calls `onSend`; Shift+Enter does not; Enter during composition does not.
  - With `waiting` set: Enter does not call `onSend`, the button is disabled, the sentence is shown, the box is
    not disabled.
  - With `off`: the box is disabled and described by the sentence.
  - Empty value: button disabled, hint shown; with text the hint is gone.
  - Escape with a quote calls `onQuoteRemove` and stops there; the chip's × does the same.
- [ ] **Step 3:** Write `AskRows.test.tsx`: `AskStopped` has no alert role and the two sentences by `afterMs`;
  `AskFailed` is an alert, "Try again" calls `onRetry`, the second button renders only when given; `AskWorking`
  shows the word, a counting time and Stop.
- [ ] **Step 4:** Run `npx vitest run src/renderer/components/ask` and see them fail.
- [ ] **Step 5:** Implement. The textarea grows with its content from 2 to 8 rows (set `rows` from the line
  count; no measuring). CSS in `ask.css` with the app's tokens: `.ask-box` (bordered, `--bg-chrome`), `.ask-chip`,
  `.ask-working`, `.ask-strip` (the bordered row both Stopped and Failed use; `.is-failed` gets `--red` border),
  `.ask-foot`. Long words wrap (`overflow-wrap: anywhere`).
- [ ] **Step 6:** Run the tests, `npm run typecheck`, `npm run lint`. Commit.

### Task 2: The dream keeps what a stopped or failed ask was

**Files:**
- Modify: `src/shared/dreams.ts` (`DreamAdjustmentSchema`)
- Modify: `src/main/dreams/dreamHandlers.ts` (`finishAsk`, `settleAsk`'s row, `dream:adjust`, `dream:adjustStop`)
- Test: the existing dream handler tests for asks (find with `grep -ln "dream:adjust" src/main/dreams/*.test.ts`)

**Interfaces (produces):** on `DreamAdjustment`, all optional:
`outcome: 'changed' | 'answer' | 'stopped' | 'failed'`, `reason: string`, `durationMs: number`,
`fix: 'settings'`.

- [ ] **Step 1:** Tests, in the style of the file's existing ask tests:
  - a stopped run appends `{ ask, quote?, at, note: '', changed: false, reverted: [], outcome: 'stopped',
    durationMs }` to the proposal's `adjustments` and leaves `adjustFailed` null;
  - a failed run appends the same with `outcome: 'failed'` and `reason`;
  - a wrong-model failure, `ASK.untested` and `ASK.notSetUp` rows carry `fix: 'settings'`;
  - a finished run's row has `outcome: 'changed'` or `'answer'` and `durationMs`;
  - starting a new ask on a proposal removes that proposal's trailing `stopped`/`failed` rows before the run;
  - `dream:adjustStop` with no run but a left-over `adjusting` writes a stopped row;
  - undo still finds the newest changed row when a stopped row follows it.
- [ ] **Step 2:** Run them, see them fail.
- [ ] **Step 3:** Implement. `durationMs` is `now() - adjusting.startedAt`. Refusals of the call itself (thrown
  before the run starts) stay thrown errors, not rows. `adjustFailed` is never written again; the schema keeps
  it for reading.
- [ ] **Step 4:** Run `npx vitest run src/main/dreams`. Commit.

### Task 3: The dream's ask on the shared parts

**Files:**
- Create: `src/renderer/components/dreams/DreamAsk.tsx` (replaces `AskBox.tsx`, which is deleted; exports
  `AskDraft`, `NO_DRAFT`, `adjustingSentence` under the same names)
- Modify: `src/renderer/screens/DreamScreen.tsx` (import), `src/renderer/styles/dreams.css` (the `.dream-ask*`
  rules that `ask.css` replaces go)
- Test: `src/renderer/components/dreams/DreamAsk.test.tsx`; update `DreamScreen.test.tsx`

- [ ] **Step 1:** Tests:
  - a row per adjustment by `outcome` (missing: by `changed`): Changed / Answer as today, `AskStopped` with its
    time, `AskFailed` with its reason;
  - "Ask again" and "Try again" call `dream:adjust` with that row's ask and quote, once for two fast clicks, and
    are disabled while any run of the result is under way;
  - `fix: 'settings'` gives the second button "Open the dream's settings" (`go({ kind: 'dream-setup' })`);
  - an old result's `adjustFailed` for this proposal renders as a failed row whose reason is its `reason`
    (`ASK.stopped`'s phrase "It was stopped" renders as a stopped row with no time);
  - while this proposal's run is under way: `AskWorking` with the ask quoted above it, the composer usable with
    the waiting sentence "Wait for this one, or stop it", Enter keeps the text;
  - another proposal's run: the composer is off with `adjustingSentence`;
  - the foot of a finished row shows `Took …` when `durationMs` is there;
  - focus and the screen-reader sentence behave as `AskBox` did (port its tests).
- [ ] **Step 2:** See them fail. **Step 3:** Implement with `AskComposer` (hint: `ASK_HINT` + " · select text
  above to ask about it", until the proposal has an adjustment) and the rows; the selection-to-quote logic moves
  over unchanged. The note stays plain text in this step.
- [ ] **Step 4:** `npx vitest run src/renderer/components/dreams src/renderer/screens/DreamScreen.test.tsx`,
  typecheck, lint. Commit.

### Task 4: The brain's ask on the shared parts

**Files:**
- Modify: `src/shared/brainAsk.ts` (`AskOutcome` failure gains `stopped?: true`), `src/main/brain/ask.ts` (sets it)
- Modify: `src/renderer/store.ts` (`AskExchange.status` gains `'stopped'`, plus `endedAt: number | null`;
  `askBrain(taskId, brainId, question, via, replaceId?)` puts the new exchange in the place of `replaceId`)
- Modify: `src/renderer/components/brain/BrainAnswers.tsx`, `BrainTab.tsx`; delete the `brain-qa-running`,
  `brain-qa-failed`, `brain-qa-follow` rules from `brain.css`
- Test: `src/main/brain/ask.test.ts`, `src/renderer/store.brainAsk.test.ts`, `BrainAnswers.test.tsx`,
  `BrainTab.test.tsx`

- [ ] **Step 1:** Tests:
  - `BrainAsks.ask` stopped returns `{ ok: false, refused: null, message: ASK_STOPPED, stopped: true }`;
  - store: a stopped outcome gives `status: 'stopped'` with `endedAt`; `askBrain(..., replaceId)` leaves the
    thread the same length with the new exchange at the old index; a second `askBrain` while one runs changes
    nothing;
  - `BrainAnswers`: running shows `AskWorking` with "Answering"; stopped shows `AskStopped` (no alert) and "Ask
    again" replaces the row; failed shows `AskFailed`, "Try again" replaces the row, the second button is "Open
    settings" for `refused: 'held'` and "Open the brain's terminal" otherwise; the follow-up composer is present
    while an answer is coming, with the waiting sentence, and keeps its text on Enter; Copy shows "Copied" and
    goes back to "Copy" after 2 s (fake timers);
  - `BrainTab`: Enter in the start box while an ask runs keeps the typed question; the box is multi-line
    (Shift+Enter adds a line).
- [ ] **Step 2:** See them fail. **Step 3:** Implement. The start box and the follow-up are `AskComposer`
  (`primary` on the start box); the agent sentence under the start box stays where it is.
- [ ] **Step 4:** `npx vitest run src/main/brain/ask.test.ts src/renderer/store.brainAsk.test.ts
  src/renderer/components/brain`, typecheck, lint. Commit.

### Task 5: The same words elsewhere, and the change note

**Files:**
- Modify: `src/renderer/components/brain/composer/Activity.tsx`, `brain/settle/SettleView.tsx` ("Retry" →
  "Try again"), `src/renderer/components/review/SendComments.tsx` ("Open an agent tab first"),
  the pull request description field (its failure line becomes `role="alert"` with the app's error colour)
- Modify their tests; `docs/telemetry.md` only if an event changed (none should)
- Create: `docs/changes/2026-11-28-ask-shared-states.md`

- [ ] **Step 1:** Change the tests' expected words; see them fail. **Step 2:** Change the words.
- [ ] **Step 3:** `npm run typecheck && npm run lint && npx vitest run src/renderer`, then the main tests for
  dreams and brain.
- [ ] **Step 4:** In the running app (scratch data, recipe in `docs/changes/2026-11-26-dream-ask-for-a-change.md`
  and `2026-11-26-guided-brain-tab.md`): a brain question, Stop, Ask again, a failure; a dream ask, Stop, Ask
  again; dark and light. Write the change note with what was seen and what was not. Commit.
