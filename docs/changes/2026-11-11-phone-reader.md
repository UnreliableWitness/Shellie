# Shellie Reader: long reads and letters on your phone

Asked for: "I think I would want to consume it in my off time eg on my smartphone", on a hosted site, where each person has "their OWN 'digest' and progress state", pushed by their Shellie to the owner's home server, stored so that the server cannot read it, with "a prioritized reading list with progression" as its home screen. This is project 3 of 3 (built second, in the owner's order 1, 3, 2): project 1 made the brain write long reads and letters (`2026-11-11-brain-long-reads.md`); the reading list and nudges inside Shellie (project 2) follow. Spec: `docs/superpowers/specs/2026-11-11-phone-reader-design.md`; mockups on the Claude Design canvas https://claude.ai/artifact/LwtD8pqm5RDHjhBWFMKJKp; plan: `docs/superpowers/plans/2026-11-11-phone-reader.md`.

The owner skipped the design questions and asked for it as soon as possible, so the open points were decided while building. They are marked **(call)** in the spec and listed under "Decided without the owner" below.

The finished thing on sample content, a 390 × 844 screen: `assets/2026-11-11-phone-reader/01-list.png` (the reading list), `02-read.png` (a long read), `03-question.png` (the question, answer held back), `04-cited-page.png` (a cited page over the piece), `05-letter.png` (a letter), `06-dark.png` (dark); `07-settings-phone.png` is Settings › User › Phone in Shellie, connected.

## What changed

- **One secret, made in Shellie, is the whole account** (`src/shared/reader.ts`). 32 random bytes, kept in `<userData>/reader.json` encrypted with safeStorage. HKDF-SHA256 derives from it the account's name on the server, the token that proves it, the AES-256-GCM key every item is sealed with, and the HMAC key that turns a name into an item id. The link for the phone is `<site address>/#<secret>`: a fragment is never sent to a server. The site takes it out of the address bar before anything else loads and keeps it in the browser's storage.
- **The server stores what it cannot read** (`reader/server`, Node, no dependencies, one bundled file). Accounts are made with an invitation code (`READER_INVITE`); items are opaque blobs under ids like `r-<32 hex>`, each with a revision (`ETag`, `If-Match`, `If-None-Match: *`). It sees the account's name, the hash of its token, a kind letter, size and time of each item: no title, no path, not which brain. Limits: 1 MB an item, 2000 items and 200 MB an account, 1200 requests a minute an account, 20 failed logins or sign-ups a minute an address. Logs hold method, path without ids, status and size. It also serves the site, with a content policy that allows the site's own origin only.
- **Shellie pushes the brains you switch on** (`src/main/reader`). Each brain has a switch "Send long reads and letters to my phone" (Settings › Project › Brains, off by default, shown once a phone is connected). For such a brain a push sends a shelf (titles, chapters, order), every long read and letter, and every page or source one of them links to, each sealed on its own. It runs 20 seconds after the brain's files change, every 15 minutes, 30 seconds after launch and on "Send now", and sends only what changed. Switching a brain off, archiving or deleting it removes its items; disconnecting removes the account.
- **Settings › User › Phone** (`PhoneSection.tsx`): server address and invitation code, Connect; then the last push ("Up to date since … · 4 pieces on your phone", or why it was not sent), "Show QR code" with "Copy link", "Send now" and Disconnect. The code is on screen right after connecting and after "Show QR code" only: it is the key, and Settings is a screen people share. When the server cannot be reached, "Disconnect anyway" forgets the connection here.
- **The site** (`reader/site`, React, built by Vite into `reader/dist/public`): the reading list in the owner's order (for your work this sprint, changed since you read it, foundations in book order with "4 of 6", later), with a bar and "9 of 31 read · about 1 h 50 min left"; a long read in a serif column with minutes left, the place in the text, "Before you read on" with the answer held back, the writer's gaps closed, "Mark as read" at the end; a letter with its four labelled parts; a cited page or source over the piece, at the heading the link named, with back returning to the place. It keeps the sealed items in IndexedDB and the app's files in a service worker, so reading works without a connection. It follows the phone's light or dark setting, fits 320 px, uses system fonts, asks no other origin, and never turns a relative link from a text into an address. "Forget this phone" removes the secret and what was kept.
- **Read marks travel both ways.** A mark is `{hash, at, read}` per piece; the newer one wins, "Mark unread" included. The phone writes the brain's marks item with `If-Match` and merges on a conflict. Shellie merges it on every push and when the Read view opens; the Read view's marks now go through main (`reader:marks`, `useReadMarks.ts`), which keeps them in `reader.json` with or without a phone. A long read brought up to date is unread again on both sides.
- **The parsing of a long read and a letter moved to `src/shared/readParts.ts`**, so the site shows them exactly as Shellie does.
- **Telemetry** (`docs/telemetry.md`): `reader.connect`, `reader.disconnect`, `reader.push`, with counts and the kind of failure. Never an address, a title, a path or an id; the requests are not recorded as dependencies. The site sends none.
- **Releases and deploy**: `reader/`, `deploy/` and `tools/reader` make no app version (`tools/release/needs-release.mjs`). `npm run reader:build` writes `reader/dist`; `deploy/aktse/docker-compose.yml` runs it on aktse in a stock `node:24-alpine` with the bundle mounted read-only; `docs/deploy-aktse.md` has the steps.

## Decided without the owner

- One machine pushes for a person: the secret is made per install. A second machine connecting makes a second account with its own link.
- What a long read or letter cites goes along, one level deep; what those pages cite does not, and such a link says so on the phone.
- The push keeps its own clock (20 s after a change, every 15 minutes, 30 s after launch) instead of the brain scheduler's tick.
- Marks stay in Shellie after a disconnect, and are kept for every brain whether a phone is connected or not.
- "Disconnect anyway" when the server cannot be reached; the account then stays on the server.
- A `429` is "later", not a failure: the push goes on 70 seconds later.
- An item over 1 MB once sealed, or a cited page over 300 000 characters, is left out.
- No pictures: a picture in a text shows as its description.
- "For your work this sprint" is in the list but nothing fills it yet; linking work items to long reads is project 2.
- System fonts, no font files.
- A stock Node image with the bundle mounted, no image build; 1200 requests a minute per account.
- The QR code hidden until asked for; the brain's switch hidden until a phone is connected.
- Reader requests are not recorded as telemetry dependencies.

## Verified

`npm test` (372 files green, among them 47 server tests, 35 site tests, the push, the marks and Settings), `npm run typecheck`, `npm run lint`.

One test (`src/main/reader/phone.test.ts`) runs the real server on a free port, pushes a brain to it with Shellie's code and reads it back with the site's code: the shelf, the piece and the page it cites; a mark made on the phone reaches Shellie and "Mark unread" in Shellie reaches the phone; a long read brought up to date is under "changed"; after Disconnect the phone learns it is no longer connected.

In the running dev app (`SHELLIE_USER_DATA=<scratch> npm start -- -- --remote-debugging-port=<port> --use-mock-keychain`, raw CDP) against the built server on this machine: a wrong invitation code was refused with its message; the right one connected and showed the QR code; switching a brain on pushed by itself about 20 seconds later (the server's log: the list, then nine items written) and Settings said "Up to date since … · 4 pieces on your phone". The link from the dev app, opened in a headless Chrome at 390 × 844: the secret was gone from the address, the list showed the brain, a long read opened, its cited page opened over it, "Mark as read" wrote the marks item, and after "Send now" Shellie's Long reads page showed that long read as read. Disconnect in Settings removed the account, and the old link then said "This phone is no longer connected".

The site alone, on a larger sample brain, in the same browser: setup and a refused link, the list with all four sections, switching brain, a place kept at 40% and found again, the letter, dark, 320 px (nothing wider than the screen), the service worker and a reload without a network ("Offline: showing what was kept", a kept long read opened). The browser reported no error apart from the fetch that failed offline, and asked no origin but the site's own.

## Known gaps

- **Not tried on a real phone.** Everything above ran in a desktop browser at a phone's size. Scanning the code with a camera, "Add to Home Screen" on iOS and Android, and how long iOS keeps the site's storage are the owner's first check. A site added to the home screen on iOS has its own storage: the link is pasted there once.
- **Not run on Windows**, where the owner's brain lives; unit tests only (CI runs them there).
- The site's code comes from the server, so whoever controls the server could serve code that sends the secret away. The encryption protects against a copied disk, a backup and a curious look, not against the server's owner. The server can also hold back a newer item; the site would not notice.
- The secret sits in the phone browser's local storage.
- No sprint section content until project 2; no pictures; one machine per person.
- The site is one 520 kB script (159 kB gzipped), loaded once and then kept by the service worker.
- Nothing prunes accounts nobody uses any more; `docs/deploy-aktse.md` says how to remove one by hand.
- The switch in Settings › Project › Brains was driven through IPC in the dev check (the scratch data folder had no project); its rendering and saving are covered by `BrainsSection.test.tsx`.
