# Performance: the renderer items left from the audit

This closes the three renderer items that `2026-11-06-performance-third-three.md` left under "Still open from the audit".

## 1. The Docs view parsed its Markdown on every render

`MarkdownView` ran remark and rehype (GFM, sanitize, slug, highlight) each time its parent rendered, so every keystroke in the Docs filter and every Docs poll parsed the open document again. It now memoizes the rendered `<Markdown>` element on the text, path, id prefix, figure set and its components. The figure set is compared by content, because a brain chapter builds a new set on each render. Callers' callbacks were already read through a ref, so a new callback does not parse again.

## 2. Every task's tabs re-rendered for any task's change

- `TerminalTabs` subscribed to the whole attention snapshot, so an agent turning blocked or done in one task re-rendered the tab row and terminals of every open task. It now selects only its own terminals' entries (`useShallow`).
- `setAttention` keeps an entry that did not change as the same object, and `setTasks` keeps unchanged tasks (and the list, when nothing changed) as the same objects. IPC sends fresh objects every time, so before this every `tasks:changed` was a new `task` prop for every `TerminalTabs`. The comparison is by JSON, which holds because both come over IPC as plain JSON.
- `TerminalTabs` is memoized, so `TaskTerminals` re-rendering for one task no longer re-renders the others.
- The nav's waiting dot (`useWaiting`) benefits too: its selected entry is now stable between snapshots.

## 3. A comment keystroke re-rendered the whole Changes tab

The draft's text lived in the store and `ChangesTab` subscribed to the whole draft, so each keystroke re-rendered the tab, the file tree and the diff view. The text still lives in the store (a rebuilt zone or leaving the tab loses nothing), but only the new `DraftBox` subscribes to it. `ChangesTab` subscribes to where the draft is, without its text, and reads the text from the store when another + asks whether the open draft has text.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests:
  - the Markdown view does not parse again when only the callbacks change, and does when the text changes (`MarkdownView.test.tsx`);
  - `setTasks` and `setAttention` keep unchanged objects (`store.test.tsx`);
  - the terminals do not render again for another task's attention or an unchanged task list, and do for their own (`TaskScreen.test.tsx`);
  - typing in a draft comment does not render the diff again (`ChangesTab.test.tsx`).

## Known gaps

- Not profiled in the running app: the gains are counted renders and parses in tests, not measured milliseconds.
- `setTasks` stringifies every task twice per `tasks:changed`. That is cheap for tens of tasks and far cheaper than the renders it saves.
