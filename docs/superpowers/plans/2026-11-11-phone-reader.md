# Shellie Reader (phone reading site) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The long reads and letters of the brains a person switches on are on their phone: a site with a prioritised reading list, the pieces and what they cite, readable offline, with read marks that travel both ways. The server stores only what it cannot read.

**Architecture:** One secret made in Shellie (`reader.json`, safeStorage) derives the account, its token, the content key and the item ids (`src/shared/reader.ts`, used by Shellie and by the site). `src/main/reader` builds a shelf per brain plus one sealed item per piece and per cited page, and pushes what changed. `reader/server` is a dependency-free Node server: accounts behind an invitation code, opaque items with revisions, and the static site. `reader/site` is a React app that takes the secret from the link's fragment, keeps the sealed items in IndexedDB and decrypts on the phone. Settings › User › Phone connects and shows the QR code.

**Tech Stack:** Electron, React 19, TypeScript, zod, WebCrypto (HKDF, AES-GCM, HMAC), Vite, Vitest + Testing Library, `qrcode-generator`, `node:24-alpine` on aktse.

**Spec:** `docs/superpowers/specs/2026-11-11-phone-reader-design.md` (design canvas: https://claude.ai/artifact/LwtD8pqm5RDHjhBWFMKJKp). Project 3 of 3 in the owner's order 1, 3, 2; the reading list and nudges inside Shellie follow.

## Global Constraints

- Nothing readable leaves the machine: every item is sealed before upload, with its id as additional data. The secret is never in a request, a log, telemetry or a URL a server sees (the link carries it in the fragment).
- A brain is sent only when its switch "Send long reads and letters to my phone" is on (default off).
- The server has no dependencies and logs method, path without ids, status and size only.
- The site asks its own origin only (CSP `default-src 'self'`), loads no third-party font or script, and never turns a relative link from a text into an address.
- No notifications, points or streaks on the phone.
- Telemetry: `reader.connect`, `reader.disconnect`, `reader.push` with counts and kinds of failure only.
- Nothing under `reader/`, `deploy/` or `tools/reader` makes an app release (`tools/release/needs-release.mjs`).
- Checks: `npm test`, `npm run typecheck`, `npm run lint` (oxfmt).

## Review Focus

- A sealed item does not open under another id, with another key or after a changed byte (Task 1 tests).
- The server refuses a sign-up without the invitation code, a wrong token, another account's items, an item or account over its limits, and a write over a revision that moved (Task 2 tests).
- A push sends only what changed, the shelf last; a brain switched off, archived or deleted leaves the server; a refused token stops the pushes (Task 3 tests).
- A newer mark wins on both sides, "Mark unread" included; a changed long read is unread again (Tasks 1, 3 and 6 tests).
- The site shows a kept piece without a connection and says when the account is gone (Task 5 tests).

---

### Task 1: Keys, sealing, shapes and the list's order (`src/shared/reader.ts`)

**Files:** Create `src/shared/reader.ts`, `src/shared/reader.test.ts`, `src/shared/readParts.ts` (the long read and letter parsing moved out of the renderer so the site shares it); Modify `src/renderer/components/brain/longReads.ts`.

- [x] `readerKeys(secret)`, `seal` / `open`, `itemId(kind, name)`, `linkFor` / `secretFromLink`.
- [x] Schemas `ReaderShelf`, `ReaderRead`, `ReaderLetter`, `ReaderPiece`, `ReaderMarks`, `ReaderStatus`.
- [x] `readingList(shelf, marks)` (work, changed, foundations, later, totals), `isMarkedRead`, `mergeMarks`.

### Task 2: The server (`reader/server`)

**Files:** Create `reader/server/{main,server,store,site,reply,testing}.ts` and tests; `tools/reader/build.mjs`; Modify `vitest.config.mts`, `tsconfig.json`, `package.json`, `.gitignore`.

- [x] Accounts behind `READER_INVITE`; token kept as a hash, compared in constant time.
- [x] Items with a per-account revision, `ETag`, `If-Match`, `If-None-Match: *`; limits and rate limits.
- [x] The static site with its headers; `GET /health`.
- [x] `npm run reader:build` writes `reader/dist/server.mjs` and `reader/dist/public/`.

### Task 3: Shellie's side (`src/main/reader`)

**Files:** Create `src/main/reader/{ReaderStore,client,build,ReaderSync,readerHandlers}.ts` and tests; Modify `src/shared/ipc.ts`, `src/shared/brain.ts`, `src/main/ipc/handlers.ts`, `src/main.ts`.

- [x] `ReaderStore`: the connection (secret encrypted), what was sent per brain, the marks of every brain.
- [x] `build`: a brain's shelf, pieces and cited pages (one level, inside the brain, size limits).
- [x] `ReaderSync`: connect, disconnect (also "anyway"), push on change, on a timer and on "Send now", marks merged on every push.
- [x] Channels `reader:status|connect|disconnect|link|send|marks`, events `reader:changed`, `reader:marksChanged`.

### Task 4: Settings and the Read view

**Files:** Create `src/renderer/components/PhoneSection.tsx` (+ test), `src/renderer/components/brain/useReadMarks.ts`; Modify `src/renderer/screens/settings/{UserScope,BrainsSection}.tsx`, `src/renderer/components/brain/BrainRead.tsx`, `src/renderer/styles/screens.css`, `docs/telemetry.md`.

- [x] Settings › User › Phone: connect, last push, "Show QR code", "Copy link", "Send now", Disconnect, "Disconnect anyway".
- [x] The brain's switch, shown once a phone is connected.
- [x] The Read view's marks go through main and follow the phone.

### Task 5: The site (`reader/site`)

**Files:** Create `reader/site/**`.

- [x] Setup (link pasted or opened), the secret out of the address bar before anything loads.
- [x] Reading list, long read, letter, cited page over the piece, places, dark mode, 320 px.
- [x] `Reader` (`sync.ts`): the list from the server, items kept sealed in IndexedDB, marks with `If-Match` and a merge on `412`.
- [x] Service worker for the app's files; "Forget this phone".

### Task 6: Together, and aktse

**Files:** Create `src/main/reader/phone.test.ts`, `deploy/aktse/{docker-compose.yml,.env.example}`, `docs/deploy-aktse.md`, `docs/changes/2026-11-11-phone-reader.md`; Modify `tools/release/needs-release.{mjs,test.ts}`.

- [x] One test with the real server, Shellie's push and the site's code: read back, marks both ways, a changed long read, disconnect.
- [x] The dev app against a server on this machine; the site in a headless browser at a phone's size.
- [x] Deploy to aktse (`/opt/shellie-reader`, healthy; a throwaway account made, used and removed there).
- [ ] The owner adds the public hostname and scans the code with a real phone.
