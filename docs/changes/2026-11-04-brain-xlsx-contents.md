# Brain: Excel workbooks as sources, and a line on what each source holds

Follows `2026-11-04-brain-images-2.md`. Two asks from the owner: ".xlsx in the brain import, this should be basic" and "give some context in that screen on what is actually in the files".

## What changed

- **XLSX** (`src/main/brain/convert/xlsx.ts`, no new dependency): a workbook becomes one `## <sheet name>` section per sheet in workbook order, each a markdown table whose first non-empty row is the header. Cells are read from the sheet XML: shared and inline strings, numbers (floating-point noise trimmed), booleans as `TRUE`/`FALSE`, formulas by their cached value, and dates as ISO dates (with the time when the serial has one) for cells whose style uses a built-in date format or a custom one with day, month, year or hour codes. Empty rows are skipped; at most 500 rows and 50 columns per sheet, the rest counted in a note. Pictures placed on a sheet (through its drawing part) are stored like a deck's. A sheet without cells says `_(empty sheet)_`; a workbook without cells or pictures is refused as empty. `formatOf` and the telemetry list know `xlsx`; the source type stays `doc`.
- **What each source holds** (`convert/describe.ts`, `describeContents`): one line computed from the converted markdown, with no model call, such as `12 slides · 3 pictures · 1 table: Acme platform: target architecture; Phase 1 scope` for a deck, `24 pages · 2 drawn pages` for a PDF, `3 sheets · 420 rows: Budget; Rates; Notes` for a workbook, `42 min · 3 speakers` for a transcript, `5 headings: …` for a document and `120 words: <first line>` for a note. It is written once into the source's frontmatter as `contents` (`renderSource`, `parseSourceFrontmatter`), returned on the add result and on `brain:sources` rows, and shown in three places: the drop notes (`Added <file> · <contents>`), the "Sources to capture" list of the inbox, and under each file in the Sources tab of the Brain screen (`BrainFiles`, which now also loads the source rows for that tab). Wiki pages and sources added before this change have no line.
- The drop zone names the formats it takes.

## Verified

`npm test` (3491 tests), `npm run typecheck`, `npm run lint` green. The workbook tests build files with JSZip: strings of both kinds, numbers, booleans, built-in and custom date styles, a formula's cached value, a cell with a pipe, two sheets, the row and column caps, a picture through a drawing, an empty sheet, garbage and a zip without a workbook, column letters and serial dates (including the 1900 leap-year quirk). `describeContents` has a test per source kind and for clipping. `addSource` tests pin the frontmatter line and the row field; the inbox test pins the drop note and the list line. No Excel-written workbook was at hand; the parser follows the ECMA-376 shapes Excel writes (unprefixed sheet elements, `r:id` relationships, shared strings, `cellXfs` styles).

## Known gaps

- Merged cells are not marked; the value sits in the top-left cell only.
- Charts in workbooks are not read (their data usually sits in cells anyway).
- Number formats other than dates are not applied: a cell showing `12%` reads `0.12`, currency reads as the bare number.
- Sheets hidden in Excel are included like the others.
- The contents line is deterministic and shallow by design; the capture's takeaways and the wiki pages remain the place for what a source means.
