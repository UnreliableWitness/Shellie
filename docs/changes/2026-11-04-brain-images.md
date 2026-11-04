# Brain: pictures, diagrams and structure reach the wiki

Spec: `docs/superpowers/specs/2026-11-04-brain-images-design.md`, plan `docs/superpowers/plans/2026-11-04-brain-images.md`. Follows the brain change note `2026-11-03-brain.md`, whose known gap "images, deck pictures and wiki attachments are dropped" this closes.

## What changed

Converting a source (`src/main/brain/convert/`) now keeps what is drawn, not only what is typed. `Converted` carries `images` (name and bytes) and the markdown references each as `{{assets}}/<name>`; `addSource` (`sources.ts`) replaces the placeholder with `sources/<name>-assets/`, writes the pictures there, commits them with the source, removes them on a failed add and reports `images` and `warnings` in its result. Only formats Claude Code's Read tool can show are stored (png, jpg, gif, webp); others are counted in one warning, and a source brings at most 60 pictures.

- **PPTX** (`convert/pptx.ts`): a slide's shapes are read in document order (`mc:Fallback` copies skipped). Pictures become `![alt]({{assets}}/slide-N-K.ext)` with the shape's alt text; a media file used on several slides is stored once. Tables become markdown tables, SmartArt a `_SmartArt:_` list of its labels (from the diagram data part), charts a `_Chart: title_` line and a table with one row per series. An embedded object's preview picture is kept.
- **DOCX** (`convert/docx.ts`): mammoth hands each picture to the converter, which stores it as `image-K.ext` and leaves `![alt](…)` in place.
- **PDF** (`convert/pdf.ts`): the images painted on each page (from pdf.js's operator list, decoded to pixels in Node) are written as PNG by `convert/png.ts`, a dependency-free encoder, and listed after the page's text. Images under 48×48 px and masks are skipped; one above 25 megapixels is skipped with a warning. A PDF without a text layer is accepted when it has pictures (warning "no text layer; captured from page images"); only a PDF with neither is still refused as "needs OCR".
- **Wiki mirror** (`mirror.ts`): the attachments the mirrored pages link (`/.attachments/<file>`, viewable formats) are checked out with `git sparse-checkout add`, copied to `sources/wiki/.attachments/`, and the links rewritten relative to each page (`../.attachments/x.png` one level down). Copies no page links any more are removed; a linked file missing from the wiki is a warning on the refresh result.
- **Skills v2** (`templates.ts`, `TEMPLATES_VERSION = 2`): `/capture` and `/sync` open every image a source links with the Read tool and write what it shows, with a diagram's components and relationships recorded as cited facts; `SCHEMA.md` names the assets folders as part of the source. Existing brains see "Update skills" in Settings › Brains.
- **UI**: after a drop, the Brain inbox and the task's Brain tab list what was added (`Added <file> · 3 pictures`) and each conversion warning, in muted text; failures stay red.
- **Telemetry**: `brain.source.added` gains `images` (`0`, `1-10`, `>10`).

## Verified

`npm test`, `npm run typecheck`, `npm run lint` green. Converter tests build PPTX and DOCX files with JSZip (pictures with alt text, shared media, EMF and linked pictures, the 60-picture cap, tables, SmartArt, charts, alternate content) and read fixture PDFs with a raw RGB image and a JPEG (decoded, encoded, read back by `decodePng`). `addSource` tests cover the assets folder in the commit, the placeholder, and the rollback; the mirror test covers copying, relinking at two depths, a non-viewable attachment left alone, a missing one warned, and removal when no page links it. Live: see the PR for the real `/capture` of a deck with a diagram picture on the test brain.

## Known gaps

- Vector drawings inside PDFs (diagrams drawn with paths rather than placed as pictures) still reach the brain as their text labels only; rendering pages to bitmaps needs a canvas dependency.
- EMF, WMF, TIFF, BMP and SVG pictures are reported, not converted.
- Pictures on slide layouts and masters (logos, backgrounds) are not extracted, by design.
- A picture that repeats across PDF pages is stored once and referenced from each page; a picture of 48 px or less on a side is never extracted, even when it carries meaning.
- The `=WxH` size suffix Azure DevOps puts on attachment links is dropped when relinking.
- Whether Claude describes a given diagram well depends on the model chosen for the brain's jobs; the capture skill asks for components and relationships, nothing enforces it.
