# Brain: images, diagrams and structure in sources

## Intent

The brain (spec `2026-11-03-brain-design.md`) converts decks, documents and PDFs to markdown text before `/capture`. Everything drawn rather than typed was dropped: pictures, exported diagrams, SmartArt, charts, and the structure of tables. For a consultancy brain the diagrams are often the most valuable part of a source (architecture, data flows, org charts, process schematics), so a capture that silently loses them is a capture the user cannot trust.

This change makes every picture in a source reach the wiki, and makes the loss visible when something still cannot be read.

## Goals

- Every picture in a PPTX, DOCX or PDF is extracted beside the source and referenced from the markdown at the place it appears (its slide, its paragraph, its page), so Claude opens it with its own vision during `/capture` and `/sync`.
- PPTX keeps what the text pass lost: SmartArt labels, chart titles and series, tables as tables, picture alt text, and the document order of shapes on a slide.
- A scanned PDF (no text layer) is accepted when it has page images; Claude reads them.
- Wiki pages mirrored from Azure DevOps bring their attachments along, with links that work from the page's folder.
- The skills tell Claude to open every image and to write what a diagram shows (components and relationships) into the pages as cited facts.
- The drop result in the UI says how many images came along and what could not be read.

## Non-goals

- No OCR library. Claude's vision does the reading at capture time.
- No rendering of PDF pages to bitmaps (needs a canvas dependency): vector drawings in PDFs are still only their text labels.
- No conversion of EMF, WMF, TIFF, BMP or SVG pictures. They are reported, not copied.
- No pictures from slide layouts and masters (logos, backgrounds).

## Anti-goals

- Bloating the brain repo with hundreds of megabytes of pictures: caps below.
- Base64 images inside the markdown.
- Rewriting the sources' text or changing the frontmatter or naming of existing sources.

## Design

### Converted result

`Converted` (`src/main/brain/convert/types.ts`) becomes:

```ts
type Converted = {
  markdown: string;        // references images as {{assets}}/<name>
  title: string | null;
  images: { name: string; data: Buffer }[];
  warnings: string[];
  empty: boolean;          // no text and no images: nothing Claude can read
};
```

`{{assets}}/` is a placeholder that `addSource` replaces once the source's file name is known. `needsOcr` is gone; `empty` takes its place. `addSource` refuses an empty conversion with reason `needs-ocr` and message "No text layer and no images; needs OCR". A PDF without text but with images is accepted with the warning "no text layer; captured from page images".

Viewable formats (what Claude Code's Read tool shows as an image): `png`, `jpg`/`jpeg`, `gif`, `webp`. Other picture formats are counted in one warning per source: "N pictures in formats Claude cannot view (emf, svg)".

Caps per source: at most 60 images; the rest are dropped with the warning "N more pictures not extracted (limit 60)". PDF images smaller than 48×48 px (bullets, rules) and image masks are skipped silently; a PDF image above 25 megapixels is skipped with a warning.

### Assets folder

Images of `sources/<name>.md` live in `sources/<name>-assets/<image>`. The folder is part of the source: never edited, committed with the source, removed with it on a failed add. `-assets` cannot collide with the original's copy (`<name>.pptx`), which `listSources` finds by `<name>.<ext>`.

### PPTX

Slide content is walked in document order over `p:sp`, `p:pic` and `p:graphicFrame` elements after `mc:Fallback` blocks are stripped (they duplicate `mc:Choice` content):

- `p:sp`: paragraphs as before, one line each.
- `p:pic`: `![<alt>]({{assets}}/slide-<n>-<k>.<ext>)` where `alt` is the shape's `descr`, else `Slide <n> picture <k>`. The media file is read through the slide's rels (`r:embed`); the same media referenced from several slides is extracted once under its first name. Linked (`r:link`) pictures are skipped.
- `p:graphicFrame` with `a:tbl`: a markdown table, cell text joined with spaces, first row as header.
- `p:graphicFrame` with `dgm:relIds`: SmartArt. The labels are read from the diagram data part (`r:dm` rel, `dgm:pt` of type `node` or `asst` or untyped) and written as `_SmartArt:_` followed by one `- ` bullet per label in document order.
- `p:graphicFrame` with `c:chart`: the chart part (`c:chart` rel). Output `_Chart: <title>_` and a markdown table with one column per category and one row per series (series name from `c:tx`, categories from `c:cat`, values from `c:val`), or just the title and series names when there are no categories.

Notes stay as before. The `images dropped` warning goes away; non-viewable formats are warned as above.

### DOCX

mammoth's `convertImage` receives each image, the converter stores it as `image-<k>.<ext>` (from the content type) and returns `{{assets}}/image-<k>.<ext>` as `src`, so mammoth writes `![alt](…)` in place. Non-viewable formats return an empty `src` and are stripped and counted as today.

### PDF

For each page, after its text, the images painted on it in order of appearance (`paintImageXObject`, `paintInlineImageXObject` from the operator list; `commonObjs` for shared ones). pdf.js decodes every image to pixel data in Node (RGB, RGBA or 1-bit grey); a dependency-free PNG encoder (`convert/png.ts`, zlib `deflateSync`, filter 0) writes `p<n>-<k>.png`. Markdown: `![p.<n> image <k>]({{assets}}/p<n>-<k>.png)` on its own line after the page's text.

`pdfToMarkdown` opens the document with `isOffscreenCanvasSupported: false` so JPEG images come out as pixels, not bitmaps.

### addSource

`writeSource` chooses the name, replaces `{{assets}}/` with `<stem>-assets/` in the body, writes the assets, stages and commits every path, and removes the whole set on failure. The result becomes `{ ok: true; path; images: number; warnings: string[] }`.

### Wiki attachments

`refreshMirror` reads each page in the subtree, collects links to `/.attachments/<file>` (absolute, as Azure DevOps writes them) and `.attachments/<file>` (relative), then runs `git sparse-checkout add` with the exact repo paths of the viewable ones (under `mappedPath`), which checks those blobs out. Each is copied to `sources/wiki/.attachments/<file>` and the page text is rewritten so the link is relative to the page's folder (`.attachments/x.png` at the top, `../.attachments/x.png` one level down, and so on). Copies no page references any more are removed. The page hash is over the rewritten text. Attachments in non-viewable formats keep their original link and are counted in the result's warnings.

### Skills and schema (templates version 2)

- `SCHEMA.md`: a `sources/<name>-assets/` folder and `sources/wiki/.attachments/` are part of the source, never edited. Citing a slide: `[Deck slide 4](../sources/2026-11-04-deck.md#slide-4)`.
- `/capture` step 2: read the source in full; for every image it references, open the image with the Read tool and write what it shows. For diagrams, schematics and charts: name every component and every relationship (arrows, containment, order, numbers) in words, and record those as facts in the pages with a citation to the source. Never skip an image; if one cannot be opened, say so in the takeaways.
- `/sync` step 4: the same when re-reading a changed source.
- `.claude/settings.json` deny list already covers `sources/**`.

`TEMPLATES_VERSION` becomes 2 so existing brains offer "Update skills".

### UI

`useBrainDrop` keeps `problems` (failed adds) and gains `notes`: one line per added file, `Added <path>` with `· N images` when images came along, and one line per warning. The Brain inbox and the task's Brain tab show notes under the drop zone in muted text until the next drop; problems stay red.

### Telemetry

`brain.source.added` gains `images` (bucket `0`, `1-10`, `>10`). `docs/telemetry.md` lists it.

## Verification

- Unit tests for each converter with files built in the test (JSZip for PPTX and DOCX, fixture PDFs built with images: one raw RGB, one JPEG) covering: pictures in order with alt text, shared media extracted once, SmartArt labels, chart table, table rendering, fallback stripping, non-viewable format warning, the 60-image cap, scanned PDF accepted, empty PDF refused, PNG encoder round trip (decode the IHDR and the inflated scanlines).
- `addSource` tests: assets written and committed, placeholder replaced, rollback removes the folder, result counts images.
- Mirror test: attachments checked out, copied, relinked, removed when unreferenced.
- Templates test: version 2 and the capture skill names images.
- Renderer test: notes shown after a drop.
- Live: a PPTX with a diagram picture through the real `/capture` on the test brain; the wiki page must name the components of the diagram.

## Left to the builder

Exact regexes, the PNG encoder's handling of 1-bit grey and RGBA, chart parsing of multiple plot types (bar and line share the structure; pie has one series), table cells with several paragraphs.
