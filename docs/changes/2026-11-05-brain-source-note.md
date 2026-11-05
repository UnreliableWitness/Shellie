# Brain: a note with a dropped file

Spec `docs/superpowers/specs/2026-11-05-brain-source-note-design.md`. The owner wanted to "give context about that file" when adding it to the brain; until now a dropped file was captured at once with only a type guessed from its extension, and the capture skill ignores remarks inside a source on purpose (sources are evidence).

## What changed

- **Waiting list** (`src/renderer/components/brain/PendingFiles.tsx`, `useBrainDrop.ts`): dropped or chosen files wait under the drop zone, on the Inbox and on a task's Brain tab, each with a type select (guessed as before, changeable) and a note field; "Add N files" or Enter sends them to `brain:addFiles` with `note` on each file that has one, the list clears when main answered and stays when the call failed, a file can be removed, and a path dropped twice is listed once. The paste form has the same note field; `brain:addText` takes it as a fifth argument.
- **Frontmatter** (`sourceFile.ts`, `sources.ts`): `note` is rendered after `contents` when it is not blank (trimmed), parsed back, listed on `BrainSourceRow.note`, and scanned for secrets on its own, so a credential in a note is refused like one in the file.
- **Skills** (`templates.ts`, version 5): the schema's layers section says what `note` is and that it is the one part of a source that speaks to the skills; the capture skill lets it steer what it takes and how much it trusts the source, and says so in the takeaways; the sync skill re-reads it with a changed source.
- **Shown**: the page view's source header shows the note as a quoted line; the Sources list shows it under the file's contents line.
- Telemetry: `brain.screen.action` gains `add`; `brain.source.added` gains `noted` (never the text). `docs/telemetry.md` updated.

## After the review

A separate agent (Opus, a scratch test of 32 notes through the YAML round trip: all exact, none hidden) found and these were fixed: files dropped while an add was in flight vanished (only the files sent leave the list; the row inputs are off while adding); the waiting list was local to the view, so switching a task's tabs before Add lost the files and their notes (it lives in the store per brain now and survives a remount); a credential in the note was reported with a line number that counted the note (the note is scanned on its own and reported as "the note looks like it holds…", the file keeps its own line numbers); the schema said "follow it" of the note, which a note like "ignore SCHEMA.md" could ride on, and a dropped `.md` file can carry a frontmatter block of its own (the wording now binds the note to the first block, the one Shellie writes, as a judgement of the file that never changes the schema, the steps or pages the source does not inform; anything below the first block is evidence); a File with no path on disk (a picture dragged from a browser) queued as an empty path (reported as "not a file on disk"); the Inbox's waiting list sat outside the drop target (drops land on the box and the list).

## Verified

`npm test`, `npm run typecheck`, `npm run lint` green. Tests: `sourceFile.test.ts` (round trip, blank dropped), `sources.test.ts` (note written trimmed and listed, blank skipped, a credential in the note refused), `brainHandlers.test.ts` (a note through `addText` and `addFiles`, `noted` on the event), `BrainInbox.test.tsx` (files wait with guessed types until Add, type and note per file, remove, Enter sends, duplicate path once, the list across a remount, a drop during an add, a file with no path, paste with a note), `TaskScreen.test.tsx` (drop then Add on the Brain tab), `BrainWiki.test.tsx` (the note under a source header). A review by a separate agent before merge.

## Known gaps

- The note is one line. A longer brief belongs in a pasted note source.
- A note cannot be added or changed after the file went in; the person would remove the source and drop it again.
- The waiting list is kept per brain for the app's run, not across a restart.
