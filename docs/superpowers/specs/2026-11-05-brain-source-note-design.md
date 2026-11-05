# Brain: a note with a dropped file

The owner asked: "When I upload a file in the brain I want to be able to give context about that file." Today a dropped file goes in with a type guessed from its extension and is captured at once; nothing the person knows about the file reaches the capture. The capture skill treats everything in a source as evidence, so a remark typed inside the document would be ignored on purpose.

## What it does

- A dropped (or chosen) file no longer goes in at once. It waits in a list under the drop zone, on the Brain screen's Inbox and on a task's Brain tab, with a type chooser (guessed from the extension, changeable) and a note field per file. One "Add N files" button (or Enter in a note field) sends them all; a file can be taken off the list first. The same path dropped twice is listed once.
- The note is written once, at ingest, into the source's frontmatter as `note:`. Sources stay untouched afterwards, so the schema's "never edit sources" rule holds. Blank notes are dropped; the note is scanned for secrets with the body.
- Pasted text gets the same note field.
- The capture skill reads `note` as what the person said about the file: the one part of a source that speaks to it rather than being evidence. It steers what is taken from the source and how much it is trusted, and the takeaways say how. The sync skill gets the same sentence; the schema documents the field.
- The page view shows the note under the source header; the Sources list shows it under the file's contents line.
- Telemetry: `brain.screen.action` gains `add` (the waiting files sent in; `drop` now means dropped or chosen); `brain.source.added` gains `noted` (whether a note was written, never its text).

## My calls

- The files wait until Add, instead of being captured at once with a note added later: a note after the capture would need a second job, and the person has the context in mind at the moment they drop the file.
- One note per file, not one per drop: a drop of three files is three different documents.
- The note lives in frontmatter rather than in the body: the body is evidence, the frontmatter is Shellie's, and the skills already read frontmatter first.
- Templates version 5: brains on v4 are offered the update on the Brain screen as before.
