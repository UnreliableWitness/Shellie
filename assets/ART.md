# Art log

Retired from the UI on 2026-10-15 (#12). The files stay in git; no screen or the splash uses them.

Generated with `tools/art/generate.mjs` (see `tools/art/README.md`). Rejected candidates stay local in
`tools/art/incoming/`. All images: generated 2026-10-14, picked by the owner 2026-10-15, model
`gemini-2.5-flash-image`, resized with `sips -Z 1600` (longest side 1600 px) and saved as JPEG.

## splash-nebula.jpg

- Candidate: `splash-nebula-2026-10-14-19-03-48.png`
- Pick: the owner chose candidate B (no reason given). Controller note: The bright spiral nebula and the mid-left ship (the prompt asked for lower left) give the splash backdrop depth behind the dial.
- Post-processing: `sips -Z 1600`, JPEG quality 80, 184 KB.
- Prompt (style block, then subject):

  > Quiet, cinematic science fiction illustration in the spirit of Iain M. Banks' Culture novels, for the background of a developer tool. Deep space black with a faint blue cast, very soft amber and dim indigo light, fine luminous lines, vast calm emptiness, painterly but restrained, low contrast, nothing busy in the middle. No text, no letters, no numbers, no logos, no watermark, no frame, no people.
  >
  > A wide field of deep space with a faint amber and indigo nebula drifting across the upper right, and far away, very small, an elongated smooth Culture General Systems Vehicle silhouette catching a sliver of amber light, off-centre to the lower left. The centre of the image is dark and empty. Landscape.

## empty-no-tasks.jpg

- Candidate: `empty-no-tasks-2026-10-14-19-03-54.png`
- Pick: the owner chose candidate B (no reason given). Controller note: Full-frame hangar mouth, no letterboxing and no off-palette lights.
- Post-processing: `sips -Z 1600`, JPEG quality 80, 243 KB.
- Prompt (style block, then subject):

  > Quiet, cinematic science fiction illustration in the spirit of Iain M. Banks' Culture novels, for the background of a developer tool. Deep space black with a faint blue cast, very soft amber and dim indigo light, fine luminous lines, vast calm emptiness, painterly but restrained, low contrast, nothing busy in the middle. No text, no letters, no numbers, no logos, no watermark, no frame, no people.
  >
  > The inside of a vast quiet hangar bay seen from deep inside, its great open mouth framing a field of stars, a thin line of amber light along the deck, no ships present, peaceful and waiting. Landscape.

## empty-no-selection.jpg

- Candidate: `empty-no-selection-2026-10-14-19-04-01.png`
- Pick: the owner chose candidate B (no reason given). Controller note: The large dark arc leaves the centre empty for the empty-state text.
- Post-processing: `sips -Z 1600`, JPEG quality 80, 186 KB.
- Prompt (style block, then subject):

  > Quiet, cinematic science fiction illustration in the spirit of Iain M. Banks' Culture novels, for the background of a developer tool. Deep space black with a faint blue cast, very soft amber and dim indigo light, fine luminous lines, vast calm emptiness, painterly but restrained, low contrast, nothing busy in the middle. No text, no letters, no numbers, no logos, no watermark, no frame, no people.
  >
  > The thin bright arc of a distant Orbital habitat ring curving across the dark, lit amber along one edge, with tiny stars beyond, almost all of the image dark. Landscape.

## empty-done.jpg

- Candidate: `empty-done-2026-10-14-19-04-10.png`
- Pick: the owner chose candidate B (no reason given). Controller note: Angular ship with an amber trail over a dark planet; thin radial lines and blue-white tones in the sky.
- Post-processing: `sips -Z 1600`, JPEG quality 80, 178 KB.
- Prompt (style block, then subject):

  > Quiet, cinematic science fiction illustration in the spirit of Iain M. Banks' Culture novels, for the background of a developer tool. Deep space black with a faint blue cast, very soft amber and dim indigo light, fine luminous lines, vast calm emptiness, painterly but restrained, low contrast, nothing busy in the middle. No text, no letters, no numbers, no logos, no watermark, no frame, no people.
  >
  > A small sleek ship drifting away into a soft amber dawn rising over the curve of a planet, a gentle sense of a job finished, mostly dark sky above. Landscape.

## about-registry.jpg

- Candidate: `about-registry-2026-10-14-19-04-16.png`
- Pick: the owner chose candidate B (no reason given). Controller note: Clean concentric dial with no drawn text; the only candidate without artefacts.
- Post-processing: `sips -Z 1600`, JPEG quality 70, 358 KB.
- Prompt (style block, then subject):

  > A precise, quiet engraving-like science fiction illustration on near-black, fine luminous amber and cream lines, like a ship's registry plate, symmetrical and calm. No text, no letters, no numbers, no logos, no watermark.
  >
  > A glowing ship Mind core, a small cream sphere with an amber halo, held in a cradle of fine concentric rings and tick marks like an instrument dial, floating in the dark. Portrait.

## get-started.jpg (pending: candidates not yet generated; the owner picks and logs)

Used on the Get started page only (the one picture in the app). Until `assets/art/get-started.jpg` exists the page
shows the app icon in the same box. No Gemini key was available when the prompt was written.

- Candidate: `get-started-<timestamp>.png` (to fill after `node tools/art/generate.mjs generate get-started`)
- Pick: to fill (which candidate, and why)
- Post-processing: to fill (JPEG under 400 KB, e.g. `sips -Z 1600`, then JPEG quality 70)
- Prompt (style block, then subject; the "Onboarding" section of `tools/art/prompts.md`):

  > Flat, minimal vector-like illustration for a developer tool, soft pale blue (#dbeafb) background, a single faceted clam shell in four blues from near-white (#f1f7ff) through #a9d0f8 and #1f56a8 to navy #122f5c, hinge up, resting on a thin pale shelf, lots of empty space, no text, no letters, no logos, no people, no gradients heavier than a soft shadow.
  >
  > The clam shell resting on the shelf slightly left of centre, its lit side towards the upper left, a soft shadow beneath it, the rest of the picture calm and empty. Landscape.

## App icon (assets/icon)

Since 2026-10-21 the app icon is a vector clam, not a Gemini picture: the conch sat small inside its navy tile and its
detail turned to mush at taskbar sizes, so next to other Windows icons it looked shrunken. In a brainstorm with mockups
at real sizes the owner picked a faceted clam (hinge up, tilted 12°, four growth bands from near-white `#f1f7ff`
through `#a9d0f8` and `#1f56a8` to a navy rim `#122f5c`) over conch, nautilus, cowrie and scallop shapes, asked for
more contrast than the first pass, and picked a pale blue tile (`#dbeafb`) for macOS. No ribs or ears, to stay clear of
the Shell oil scallop. On Windows the clam fills the square with no tile; the -small drawings have fewer facets.
`assets/icon/shellie-art.jpg` is gone; the history below is kept for the record.

### The Gemini conch (2026-10-18 to 2026-10-21)

- Generated 2026-10-18 with `gemini-2.5-flash-image`, one candidate per subject (nautilus, scallop, prompt, hermit
  crab, conch; prompts in the "App icon" section of `tools/art/prompts.md`).
- Pick: the owner chose the conch (`icon-conch-2026-10-18-08-09-11.png`, kept local): an upright faceted conch with a
  cursor glowing in its opening, so it says both seashell and terminal.
- Shipped as the picture itself, as `assets/icon/shellie-art.jpg` (JPEG quality 90, 109 KB). A vector redraw was tried
  first and rejected by the owner ("I liked the first one way better").
- The four SVGs in `assets/icon` place it inside each platform's tile: the 48 px+ drawings crop to the inside of
  Gemini's own rounded tile (pixels 40-984), the 16-32 px drawings crop closer to the shell (140-884). `npm run icons`
  renders the PNGs, `.ico` and `.icns`; `MindMark.tsx` shows `png/64.png`.

## agents/avatar.png (the shellie-agents GitHub App's avatar)

- Generated 2026-10-26 with `gemini-2.5-flash-image`, 1:1, seven candidates over two rounds (section "Agent avatar" and
  "Agent avatar, robot" in `tools/art/prompts.md`). The first round (a clam with a cursor eye, an antenna, a prompt)
  was not bot-like enough; the second asked for LED eyes, a visor or screen face and an antenna.
- Candidate: `avatar-bot-hermit-2026-10-26-13-07-27.png`
- Pick: the owner chose the hermit crab bot.
- Post-processing: GitHub shows avatars as a 20-40 px circle, so the square is cropped to 700 px around (471, 469) of
  the 1024 px candidate, the smallest crop whose circle still holds the antenna's glowing tip (the circle trims the
  shell's outer tips), then scaled back to 1024 px with Lanczos: the bot shows 1.46x larger. PNG, uploaded by the
  owner at github.com/settings/apps/shellie-agents (GitHub has no API for an app's avatar).
- Prompt (style block, then subject):

  > A GitHub profile avatar for "shellie-agents", a friendly robot that triages, fixes and ships a developer tool called Shellie. Unmistakably a robot: glowing LED eyes, a visor or screen face, an antenna. Flat faceted low-poly style like the Shellie app icon, crisp flat planes in four blues, near-white (#f1f7ff), #a9d0f8, #1f56a8 and navy (#122f5c), with the eyes and glowing parts in bright ice-cyan (#7fe3ff). Centred, filling about two thirds of the square. The soft pale blue (#dbeafb) background fills the whole square edge to edge: no tile, no rounded corners, no dark corners, no border. GitHub crops it to a circle and shows it at 20 to 40 pixels, so one bold, cheerful silhouette with big simple shapes and no fine detail. No text, no letters, no numbers, no logos, no watermark.
  >
  > A tiny faceted robot hermit crab peeking out of a faceted clam shell, two glowing ice-cyan eyes on short stalks, one small claw raised in a wave, the shell bigger than the crab.
