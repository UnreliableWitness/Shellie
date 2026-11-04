# Brain Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pictures, diagrams, SmartArt, charts, tables and wiki attachments reach the brain beside their source and are read by Claude at capture time.

**Architecture:** Converters return `images` plus markdown that references `{{assets}}/<name>`; `addSource` writes a `<stem>-assets/` folder and rewrites the placeholder; the mirror copies referenced wiki attachments and relinks them; templates v2 tell the skills to open every image.

**Tech Stack:** jszip, mammoth, pdfjs-dist (legacy build), node zlib for PNG, vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-brain-images-design.md`

## Global Constraints

- Viewable formats: png, jpg, jpeg, gif, webp. Others warned, never copied.
- Caps: 60 images per source; PDF images < 48×48 px skipped silently; > 25 MP skipped with a warning.
- Placeholder `{{assets}}/` in converter output; assets folder `sources/<stem>-assets/`.
- Single quotes, oxfmt formatting, zod 4, no new dependencies.
- Sources never edited by skills; `.claude/settings.json` deny on `sources/**` unchanged.

## Review Focus

- A PPTX whose picture is referenced on two slides: extracted once, both slides link it.
- A scanned PDF: accepted with the "no text layer" warning, not refused.
- A PDF with only a tiny bullet image and no text: refused as needs-ocr (image skipped by size).
- A wiki page whose attachment link is absolute `/.attachments/x.png` two folders down: rewritten to `../../.attachments/x.png`.
- A failed commit after assets were written: the assets folder is gone afterwards.

---

### Task 1: Converted type, PNG encoder, PDF images
Files: `convert/types.ts`, `convert/png.ts` (new), `convert/pdf.ts`, `convert/index.ts`, fixtures `images.pdf` (raw RGB + grey) and `jpeg.pdf`, `convert/convert.test.ts`, `convert/png.test.ts`.

### Task 2: PPTX pictures, tables, SmartArt, charts
Files: `convert/pptx.ts`, `convert/convert.test.ts`.

### Task 3: DOCX images
Files: `convert/docx.ts`, `convert/convert.test.ts`.

### Task 4: addSource assets and result
Files: `sources.ts`, `src/shared/brain.ts` (`AddSourceResult`), `sources.test.ts`, `brainHandlers.ts` (telemetry `images` bucket), `brainTelemetry.ts`.

### Task 5: Templates v2
Files: `templates.ts`, `scaffold.test.ts` or templates test.

### Task 6: Wiki attachments in the mirror
Files: `mirror.ts`, `mirror.test.ts`.

### Task 7: UI notes after a drop
Files: `useBrainDrop.ts`, `BrainInbox.tsx`, `BrainTab.tsx`, their tests, `brain.css` if needed.

### Task 8: Docs
Files: `docs/changes/2026-11-04-brain-images.md`, `docs/telemetry.md`, known gaps in the brain change note untouched (new note supersedes).

### Task 9: Live check
A PPTX with a diagram picture through the real `/capture` on the test brain, GUI-free (temporary vitest file, deleted after).
