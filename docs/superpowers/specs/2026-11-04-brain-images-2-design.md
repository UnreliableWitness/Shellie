# Brain: drawn pages, other picture formats and layout pictures

Addendum to `2026-11-04-brain-images-design.md`. It closes the gaps that spec left open: vector drawings inside PDFs, pictures in formats Claude cannot view, and pictures on slide layouts and masters.

## Intent

A diagram drawn with lines and boxes inside a PDF, an EMF pasted from Visio into a deck, a logo-bearing template: today these are text labels or a warning. They must reach the wiki like any other picture.

## Goals

- A PDF page that carries a drawing is rendered to a PNG and linked from the page's section, so Claude sees the drawing as drawn.
- Pictures in SVG, BMP, ICO, EMF, WMF and TIFF are converted to PNG where the machine can do it; what it cannot do is still one warning.
- Pictures on the slide layouts and master of a deck are extracted once, in their own section at the end.
- Alternate content nested inside alternate content resolves correctly.

## Non-goals

- No OCR. No change to the skills: they already open every linked image.
- No rendering of every PDF page: only pages with a drawing, up to a cap.

## Design

### Canvas

`@napi-rs/canvas` (prebuilt N-API binaries, no system dependencies) joins the dependencies at an exact version. pdf.js finds it by itself for page rendering (`require('@napi-rs/canvas')` in its Node canvas factory); the converters import it dynamically for rasterising. It is external to the Vite main bundle, kept in the package by `keepInPackage` (the package's own JS plus the target platform's binding package only) and unpacked from asar so the `.node` file sits on disk. When it cannot be loaded, page rendering and in-process rasterising are skipped with one warning per source; nothing else changes.

### PDF page rendering

For every page the operator list is counted: `constructPath` operations and the sum of their bounding-box areas (pdf.js hands each path's min/max). A page is rendered when it has at least 8 paths whose summed area covers at least 5 % of the page, which separates diagrams and filled tables from underlines, rules and a vector logo. Rendering is at a scale that makes the longer side 1600 px; the result is `p<n>.png`, linked as `![p.<n> as drawn]({{assets}}/p<n>.png)` right after the page's text, and the page's own images are not extracted separately (the render shows them). At most 20 pages per PDF are rendered, in page order; the rest get the warning "N more pages with drawings not rendered (limit 20)".

### Other picture formats

`ImageCollector` gains a `rasterize` hook: `(data, ext) => Promise<Buffer | null>` returning PNG bytes or null. Converters call `addAny(name, data, ext)`: viewable formats are stored as they are, others go through the hook and are stored as `<name>.png`; null means the picture is counted in the existing "formats Claude cannot view" warning.

`convert/raster.ts` builds the hook used by the app:

1. In process, with `@napi-rs/canvas` `loadImage`: `svg`, `bmp`, `ico`.
2. Through the platform, with temp files: `Platform.rasterizeCommand?(src, dest)` returns a command that writes a PNG, or null when the platform cannot. Windows (the release target): PowerShell with `System.Drawing` (`[System.Drawing.Image]::FromFile($src).Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)`) for `emf`, `wmf`, `tif`, `tiff`, `bmp`. macOS: `sips -s format png` for `tif`, `tiff`, `bmp`, `gif`; EMF and WMF stay unconverted there.

The hook never throws: any failure is null.

### Layout and master pictures

A slide's rels name its layout (`…/slideLayout`), and the layout's rels its master (`…/slideMaster`). Pictures (`p:pic` with an embedded blip) on each distinct layout and master used by the deck are extracted once, named `layout-<k>.<ext>`, and listed in a final section:

```
## Slide layouts and master

Pictures that appear on the slide layouts and master (logos, backgrounds), once each.
![<alt>]({{assets}}/layout-1.png)
```

Nothing is written when there are none.

### Alternate content

The resolver replaces innermost `mc:AlternateContent` blocks first (a block whose body holds no further block), repeating until none remain, so nesting cannot leave a Fallback behind.

## Verification

- Unit: a fixture PDF with a drawn diagram on page 1 and a plain page 2 (page 1 rendered, page 2 not; a 48 px floor unchanged); the 20-render cap; the rasterize hook with a fake; in-process SVG and BMP rasterising with the real canvas; the Windows and macOS `rasterizeCommand` shapes; layout and master pictures once each; nested alternate content; `keepInPackage` for the canvas packages per target.
- Packaged build (`electron-forge package`) contains `@napi-rs/canvas` and the host's binding package, and the packaged main can load it.
- Live: `vector.pdf` and a deck with an SVG picture through `addSource` and a real `/capture`.
