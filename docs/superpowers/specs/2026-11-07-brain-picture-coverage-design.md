# Brain: every picture interpreted

Date: 2026-11-07. Follows `docs/changes/2026-11-04-brain-images.md` and `2026-11-04-brain-images-2.md` (how pictures reach `sources/`) and the checks in `2026-11-04-brain-checks.md` (findings Shellie computes itself). Mockups: `assets/2026-11-07-picture-coverage-source.png`, `assets/2026-11-07-picture-coverage-health.png` (next to this file).

## Why

The owner worries the brain does not carry everything in the files dropped into it. The part they want to be sure of: **every picture in a source was looked at and its meaning written into the brain**. Today `/capture` is told to open every picture, but nothing checks that it did, and pictures the converter dropped (over the cap, a format it could not convert, too small) show up only as a `> Note:` line in the source text.

Success: for every source, Shellie can say exactly how many pictures it holds, which ones a wiki page describes, which ones Claude judged to carry nothing, which ones nobody interpreted yet, and which ones never reached Claude and why. Gaps are re-evaluated by Claude without anyone asking, once.

## Goals

1. Every picture of every source has one of four statuses, computed by Shellie without Claude:
   - **described**: a page under `wiki/` links to the picture file.
   - **nothing to record**: Claude marked it as carrying no knowledge, with a short reason ("company logo on every slide", "stock photo").
   - **not interpreted**: neither of the above.
   - **never reached Claude**: the converter could not deliver it (cap, unconvertible format, too large, render cap), with the reason and what the owner can do. The owner can mark such a drop "fine, I know" (**accepted**): it stops flagging but stays listed, so nothing is hidden.
   - PDF images under 48 px a side (bullets, icons; `MIN_IMAGE_SIDE` in `convert/pdf.ts`) are counted only ("plus 23 tiny images not looked at") and never flagged, or nearly every PDF would carry a permanent warning.
2. When a capture leaves pictures not interpreted, Shellie queues one re-evaluation job for that source right away; Claude gets only those pictures and either describes each on a page or marks it nothing to record.
3. If gaps remain after that one automatic run, Shellie stops, shows them, and offers a Re-evaluate button (each press is one more run).
4. Sources captured before this change are checked too: once a brain has the new skills, each of its earlier sources with gaps gets one re-evaluation, in the background, through the normal job queue.
5. The status is visible on the source (Read view), on the Health card, in the inbox after a drop, and the one-time pass in What runs by itself (see mockups).

## Non-goals

- Coverage of text (sections, slides, tables). Only pictures, as the owner chose. The design should not block a later text coverage, but builds none of it.
- Judging whether a description is good. "Described" means a page cites the picture, nothing more.
- Fixing why pictures never reach Claude (lifting the 60 cap, EMF on macOS). The report names the reason and the way around it; the converter limits stay.

## Anti-goals

- Claude writing filler about logos and decorations to make the report green. That is what "nothing to record" with a reason is for.
- Re-evaluation that loops or spends on its own: one automatic run per capture, one more per button press, always through the runner's daily token cap.
- Shellie or a skill editing anything under `sources/` (the brain's rule since PR #217).
- A report that nags forever: a picture marked nothing to record is done, and the owner can see the reason.

## How it works

### The four statuses

- **The pictures of a source** are the files in `sources/<stem>-assets/` (all four formats Claude can view; anything else was already converted or dropped). For the wiki mirror, `sources/wiki/.attachments/` holds the pictures of `sources/wiki/**`; those count as one source, "Wiki mirror". After a refresh that brings new or changed pictures, Shellie queues one automatic re-evaluation for the mirror (the same rule as after a capture: one automatic run, then the button); the job has no source file, so the builder decides how it names the mirror.
- **Described**: any markdown link or image under `wiki/**/*.md` whose target resolves (with `localTarget` in `check.ts`) to the picture file. A page may embed it (`![…](…)`) or link it (`[Slide 4 diagram](../sources/…-assets/slide-4-1.png)`); both count.
- **Nothing to record**: an entry in `brain/pictures-skipped.json`, which skills write and Shellie only reads: `{ "<repo-relative picture path>": { "reason": "company logo on every slide", "at": "<ISO>" } }`. Entries whose file no longer exists (a removed source) are ignored, and pruned when Shellie next writes the brain (builder's choice when).
- **Never reached Claude**: recorded by Shellie at add time in `brain/pictures-dropped.json`: `{ "<source path>": { "dropped": [ { "where": "slide 9, picture 2", "reason": "EMF converts on Windows only", "fix": "Re-add the deck on Windows, or save the picture as PNG", "accepted": null } ], "tiny": 23 } }`. "Fine, I know" sets `accepted` to the ISO time (Shellie writes it on the owner's click; a button on the drop's row in the source panel and on its Health finding). Only drops with `accepted: null` count as gaps. The wiki mirror's attachments that are not viewable (`attachmentsOf` returns them as `other` in `mirror.ts`) are recorded under the key `sources/wiki` at each refresh, replacing that key's list but keeping `accepted` for drops that are still there (matched by `where`). The converters' `ImageCollector` (and the PDF render cap) must report each dropped picture individually with where it was, instead of only the counted warning; the warnings stay as they are. For sources added before this change, the one-time pass rebuilds their entries by converting the stored original again (`sources/<stem>.<ext>`), writing only this file, never the source; a source without an original copy (pasted text) has none.

Two files, two writers: Shellie never writes `pictures-skipped.json`, skills never write `pictures-dropped.json` (add both paths to the right allow/deny lists in the brain's `.claude/settings.json`).

### Labels shown for a picture

Shellie derives "Slide 4", "Page 3", "Slide layouts and master" from the asset name the converters already use (`slide-N-K`, `pN`, `layout-K`, `image-K`) and the alt text from the `![alt](…)` that links it in the source. Exact wording is the builder's.

### Skills (templates v6)

- `/capture` and `/sync`: after opening each picture, either write what it shows on a page **with a link to the picture file as the citation**, or add it to `brain/pictures-skipped.json` with a reason. A picture that carries knowledge must never be marked skipped. Read the file before writing it and keep other entries.
- New skill for re-evaluation (name is the builder's, e.g. `/pictures`): takes a source and the list of picture paths Shellie found not interpreted; opens each, then describes or marks it as above. It may update existing pages instead of creating new ones.
- `/retract`: nothing new (Shellie ignores skipped entries for removed files).
- Existing brains see "Update skills" in Settings › Brains as with every template bump; the one-time pass waits for v6.

### Re-evaluation

- After a `capture` job for a source finishes ok, Shellie computes that source's statuses. If any picture is not interpreted, it queues one re-evaluation job for the source with exactly those pictures. A re-evaluation job never queues another one.
- The Re-evaluate button (source panel and Health finding) queues one re-evaluation job with the current gaps.
- Jobs run through `BrainJobRunner` like every other kind: same lock, model, daily cap, pause, telemetry (`brain.job` gains the new kind).
- The job needs the picture list in its prompt; today a job carries only `source`. Builder decides how (an argument list on the job, or the skill reading a file Shellie writes).

### One-time pass for earlier sources

- Runs once per brain, when its templates are v6 and the pass has not run (a flag on the brain record). It first rebuilds `pictures-dropped.json` entries from originals, then queues one re-evaluation job per source with gaps, oldest first.
- Scale: earlier skills cited `sources/x.md#slide-4`, not picture files, so nearly every earlier picture starts as not interpreted and the pass queues a job for nearly every source with pictures; on a picture-heavy brain that is days of the daily cap. The owner accepted this. A `#slide-N` anchor does **not** count as described: it would let a picture nobody opened pass.
- The pass's jobs wait behind normal jobs: a capture, sync or re-evaluation queued while the pass runs goes first. Builder decides the mechanism (a lower-priority lane in the runner, or queuing one pass job at a time).
- Shown as a line in What runs by itself with progress ("6 of 23 done") while it runs; gone when done. Paused by the daily cap like every job; it resumes the next day.
- Expected cost: real usage on the owner's subscription for a picture-heavy brain. Nothing beyond what the runner's cap allows per day.

### UI (mockups)

- **Source page (Read view)**: a Pictures panel above the source text with the counts per status, a bar, and one row per picture: thumbnail, label and alt text, the pages that describe it (links), the skip reason, or the drop reason and fix; status tag on the right. Show the first few rows, "Show all N" for the rest. Re-evaluate button when any picture is not interpreted. The header gets a warn tag when gaps exist.
- **Health card**: a Pictures fact line ("211 of 214 interpreted · 1 not interpreted · 2 never reached Claude") and a new finding kind `picture` per source with gaps (not per picture), with Re-evaluate (not interpreted) or Open source (never reached Claude, where each drop has "Fine, I know"). Accepted drops and tiny images are not gaps: no finding, no warn tag. `picture` joins `SHELLIE_FINDING_KINDS`.
- **Inbox after a drop**: the existing "Added … · N pictures" line, the drops in words, then the capture result for pictures and "re-evaluating N pictures…" while that runs.
- **Task Brain tab**: the same lines as the inbox, as today for drops.

## Telemetry

`brain.job` gains the new kind. `brain.screen.action` gains `reevaluate`. A new `brain.pictures` event after each computed status for a source is the builder's call; if added, buckets only (counts per status), never paths or reasons. Keep `docs/telemetry.md` in sync.

## Left to the builder

- How the picture list reaches the re-evaluation job, and the skill's name.
- Where the per-source statuses are computed and cached (on `brain:get` with the other checks is the obvious home; they must stay cheap for a brain with thousands of pictures).
- Thumbnail size and loading in the panel; how many rows show before "Show all".
- Exact wording of labels, reasons and fixes.
- Whether the wiki mirror's attachments share the source panel or get their own place.

## Calls made in the brainstorm (owner did not decide these)

- "Described" means cited by a page link to the picture file, not judged on quality.
- The skip marks and drop records live in two files under `brain/`, one per writer, because nothing may edit `sources/`.
- One automatic re-evaluation per capture; manual after that.
- The one-time pass rebuilds drop records from stored originals.
- The Health card lists one finding per source, not per picture.
- Wiki mirror attachments are in scope, with one automatic re-evaluation after a refresh that brings new pictures.
- Tiny PDF images are counted, never flagged.
- The one-time pass yields to normal jobs.

## Decided by the owner

- Pictures only, not text coverage.
- Gaps are re-evaluated by Claude, automatically.
- Pictures with nothing to know are marked as such, with a reason.
- Earlier sources are checked too, accepting the cost of re-reading nearly every earlier picture.
- A drop can be marked "fine, I know"; it stays listed.
- The mockups (source panel, Health card, inbox, What runs by itself).
