# Brain: a note with a dropped file

Spec `docs/superpowers/specs/2026-11-05-brain-source-note-design.md`. The owner wanted to "give context about that file" when adding it to the brain; until now a dropped file was captured at once with only a type guessed from its extension, and the capture skill ignores remarks inside a source on purpose (sources are evidence).

## What changed

- **Waiting list** (`src/renderer/components/brain/PendingFiles.tsx`, `useBrainDrop.ts`): dropped or chosen files wait under the drop zone, on the Inbox and on a task's Brain tab, each with a type select (guessed as before, changeable) and a note field; "Add N files" or Enter sends them to `brain:addFiles` with `note` on each file that has one, the list clears when main answered and stays when the call failed, a file can be removed, and a path dropped twice is listed once. The paste form has the same note field; `brain:addText` takes it as a fifth argument.
- **Frontmatter** (`sourceFile.ts`, `sources.ts`): `note` is rendered after `contents` when it is not blank (trimmed), parsed back, listed on `BrainSourceRow.note`, and scanned for secrets together with the body, so a credential in a note is refused like one in the file.
- **Skills** (`templates.ts`, version 5): the schema's layers section says what `note` is and that it is the one part of a source that speaks to the skills; the capture skill lets it steer what it takes and how much it trusts the source, and says so in the takeaways; the sync skill re-reads it with a changed source.
- **Shown**: the page view's source header shows the note as a quoted line; the Sources list shows it under the file's contents line.
- Telemetry: `brain.screen.action` gains `add`; `brain.source.added` gains `noted` (never the text). `docs/telemetry.md` updated.

## Verified

`npm test`, `npm run typecheck`, `npm run lint` green. Tests: `sourceFile.test.ts` (round trip, blank dropped), `sources.test.ts` (note written trimmed and listed, blank skipped, a credential in the note refused), `brainHandlers.test.ts` (a note through `addText` and `addFiles`, `noted` on the event), `BrainInbox.test.tsx` (files wait with guessed types until Add, type and note per file, remove, Enter sends, duplicate path once, paste with a note), `TaskScreen.test.tsx` (drop then Add on the Brain tab), `BrainWiki.test.tsx` (the note under a source header). A review by a separate agent before merge.

## Known gaps

- The note is one line. A longer brief belongs in a pasted note source.
- A note cannot be added or changed after the file went in; the person would remove the source and drop it again.
- The waiting list lives with the view: switching tabs before Add forgets it.
