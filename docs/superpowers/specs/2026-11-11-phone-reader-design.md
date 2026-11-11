# Shellie Reader, the phone reading site: design

Date: 2026-11-11. Branch `feat/phone-reader`. Third of three projects (1: the brain writes for you, done in PR
#276; 3: this; 2: the reading list and nudges in Shellie, later). Mockups: the Claude Design canvas
https://claude.ai/artifact/LwtD8pqm5RDHjhBWFMKJKp (reading list, long read, letter).

The owner skipped the design questions and asked for it as soon as possible. Everything under "Decided by the
owner" is theirs, from the brainstorm; everything else is my call and is listed as such.

## Why

Long reads and letters (project 1) are read in Shellie, at a desk, during work. The owner reads in their own time,
on a phone, and stopped reading when it was only in the app. So the pieces a brain writes go to a site the person
opens on their phone, with a reading list that says what to read next and remembers what they read.

## Decided by the owner

- A hosted site, no app. Each person has their own pieces and their own progress; nobody sees another's.
- Each person's Shellie pushes to the owner's home server (aktse).
- The server stores only what it cannot read: the key is made in Shellie, pieces are encrypted before upload, the
  key reaches the phone once by QR code and is never sent to the server.
- The home screen is a prioritised reading list with progress, in this order: work in front of you this sprint,
  changes to things you already read, foundations not yet read in book order, later.
- No notifications on the phone. No points, streaks or guilt.

## Goals

1. A person connects Shellie to the server once, scans a QR code with their phone, and from then on the long reads
   and letters of the brains they switch on are on the phone.
2. The server and anyone who copies its disk learn nothing about the content: not a title, not a path.
3. What is marked read on the phone is read in Shellie, and the other way round.
4. Links in a piece open the page or source they cite, on the phone.
5. Reading works without a connection once the pieces were loaded.

## Not in this project

- The reading list and nudges inside Shellie (project 2). The list's order lives in `src/shared/reader.ts` so
  project 2 uses the same one.
- "Work in front of you this sprint" (the first section of the list). Nothing in Shellie links a work item to a
  chapter or long read yet; that link is project 2's. The list has the section, and a piece carries `work` when
  something sets it; nothing sets it yet. **(call)**
- Pictures. Pieces and what they cite go as text.
- Accounts with a password, password reset, an admin page. Access is the link in the QR code.
- A second machine pushing for the same person (the brain lives on one machine).

## What must not happen

- Customer content readable on the server, in its logs, or in telemetry.
- A brain's content leaving the machine without the person switching that brain on.
- The secret in a request, a log, a URL the server sees, or telemetry.
- An open blob store for the internet: only someone with the server's invitation code can make an account.

## The parts

```
src/shared/reader.ts        keys, sealing, item ids, the shapes, the order of the reading list (Shellie and site)
src/main/reader/            Shellie: the connection, the push, the marks
reader/server/              the server: accounts and opaque items, serves the site
reader/site/                the site: a small React app, built with Vite
deploy/aktse/               compose file and .env.example for aktse
```

## Keys and what the server sees

One **secret**: 32 random bytes made in Shellie, kept in `reader.json` in the user data folder, encrypted with
safeStorage. Everything else is derived from it with HKDF-SHA256 (salt `shellie-reader-v1`, info as named):

| derived | info | use |
|---|---|---|
| reader id | `id` | 16 bytes, hex: the account's name on the server |
| token | `token` | 32 bytes, base64url: proves the account to the server |
| content key | `enc` | AES-256-GCM key for every item |
| id key | `ids` | HMAC-SHA256 key that turns a name into an item id |

- The **link** is `<site address>/#<secret, base64url>`. The QR code holds the link. A fragment is never sent to a
  server. The site reads it, keeps the secret in the browser's local storage, and removes it from the address bar.
- An **item** is one encrypted blob: `0x01`, a 12-byte random nonce, then AES-GCM ciphertext and tag, with the
  item's id as additional data (the server cannot serve one item as another).
- An **item id** is a kind letter, `-`, and the first 32 hex characters of HMAC(id key, name): `m-…` a brain's
  shelf, `r-…` a long read or letter, `p-…` a cited page or source, `k-…` a brain's marks. The name is
  `<brain id>` for `m` and `k` and `<brain id>:<path>` for the others.
- The server sees: the reader id, the hash of the token, the kind letter, size and time of each item. It cannot
  tell which brain an item belongs to.
- Honest limit: the site's code comes from the server. Someone who controls the server can serve code that sends
  the secret away. The encryption protects against a copied disk, a backup and a curious look, not against the
  server's owner turning hostile. Stated in the note.

## The server (`reader/server`)

Node, no dependencies, one bundled file, files on disk. All API paths under `/api/v1`. Auth:
`Authorization: Bearer <reader id>.<token>`; the server keeps a SHA-256 of the token and compares in constant time.

| call | does |
|---|---|
| `GET /health` | `200 ok` |
| `POST /api/v1/readers` `{invite, reader, token}` | makes the account. `403` wrong or no invitation, `200` when it exists with this token, `409` with another |
| `GET /api/v1/hello` | `{server: "shellie-reader", v: 1}` |
| `DELETE /api/v1/reader` | removes the account and all its items |
| `GET /api/v1/items` | `{items: [{id, rev, size, at}]}` |
| `GET /api/v1/items/:id` | the bytes, `ETag: "<rev>"` |
| `PUT /api/v1/items/:id` | stores the bytes, answers `{rev}`. With `If-Match: "<rev>"` only over that revision, with `If-None-Match: *` only when absent, else `412` |
| `DELETE /api/v1/items/:id` | `204` |

- `rev` is a counter per account, so a newer item always has a higher one.
- Limits **(call)**: an item 1 MB, an account 2000 items and 200 MB, 1200 requests a minute per account (a first push of a large brain is several hundred items), 20 failed
  logins or sign-ups a minute per address (`CF-Connecting-IP`, else the socket's). Over a limit: `413` or `429`.
- The invitation code is `READER_INVITE` in `/opt/shellie-reader/.env`. Empty: nobody can sign up.
- Storage: `<data>/readers/<reader id>/reader.json` (token hash, created, counter, the item index) and
  `<data>/readers/<reader id>/items/<item id>`. Writes go to a temp file and are renamed.
- Everything else is the site: static files from the public folder, `index.html` for unknown paths, with
  `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `Referrer-Policy:
  no-referrer`, `X-Content-Type-Options: nosniff`. Hashed assets are cached for a year, the rest not.
- Logs: method, path without the item id, status, size. Never a header or a body.

## What Shellie sends (`src/main/reader`)

Per brain with "Send to my phone" on, three kinds of item, each JSON, sealed:

```ts
type ReaderShelf = {           // m-: one per brain
  v: 1; brainId: string; name: string; sentAt: string;
  chapters: string[];          // the book's chapters that have pages, in order
  reads: ReaderRead[]; letters: ReaderLetter[];
  refs: Record<string, { id: string; title: string }>;  // every cited page or source that was sent, by path
};
type ReaderRead = { id: string; path: string; title: string; summary: string; chapter: string | null;
  topic: string | null; written: string | null; minutes: number; hash: string; stale: boolean;
  work?: { id: number; title: string }[] };
type ReaderLetter = { id: string; path: string; title: string; read: string; written: string | null;
  minutes: number; hash: string };
type ReaderPiece = { v: 1; path: string; title: string; text: string };   // r- and p-: the file's body
type ReaderMarks = { v: 1; marks: Record<string, { hash: string; at: string; read: boolean }> };  // k-
```

- **What is cited**: every relative link in a long read or letter to a `.md` file under `wiki/` or `sources/`
  inside the brain. Each goes once as a `p-` item, its body as text. One over 300 000 characters is not sent
  **(call)**; its link then says where to find it.
- **When**: 20 seconds after a brain's files change (a job ended), every 15 minutes, 30 seconds after launch, and
  on "Send now" in Settings. One push at a time; a change during a push runs one more after it. The sync keeps its
  own clock rather than the brain scheduler's tick **(call)**: that tick is about what a brain may spend, and a
  push spends nothing.
- **How**: Shellie keeps, per brain, the hash of what it last sent for each item id. A push builds everything,
  sends the items whose hash differs or that the server no longer lists, deletes the ones no longer wanted, and
  writes the shelf last. Nothing changed: no request beyond the list.
- **Off**: switching a brain off, archiving or deleting it removes its items from the server. Disconnecting
  removes the account.
- **Scrub**: a scrub changes the files, so the next push overwrites what was sent.
- **Failure**: quiet. Settings shows the last result ("Up to date since 14:02 · 12 pieces on your phone", or "Not
  sent at 14:02: The reader server could not be reached"). Retried on the next tick. A refused token stops the
  pushes until the connection changes. `429` is no failure: the push goes on 70 seconds later, with what was sent
  already not sent again **(call)**.
- **Too large**: an item that would be over the server's 1 MB once sealed is left out, like a cited page over
  300 000 characters **(call)**.
- **Links followed one level**: what a long read or letter cites goes along; what those pages cite does not
  **(call)**. A link on a cited page to a page that was not sent says so on the phone.

### Marks

A mark is `{hash, at, read}` per path: read means marked with the text's current hash, as in project 1. `read:
false` is "Mark unread", kept so it can win over an older read mark. The newer `at` wins.

- The phone writes the `k-` item with `If-Match`; on `412` it fetches, merges and tries again.
- Shellie fetches the `k-` item on every push and when the Read view opens, merges it with its own marks
  (`reader.json`), and writes it back when it had something newer.
- The Read view keeps its localStorage marks and hands them to main (`reader:marks`), which answers with the
  merged set; a mark set in Shellie goes to main the same way. Main tells the windows when a push brought marks
  from the phone (`reader:marksChanged`).
- Main keeps the marks of every brain, with or without a phone, and keeps them after a disconnect **(call)**:
  they are the person's, and project 2 reads them from there.

## Connecting (Settings › User › Phone)

1. Not connected: "Server address" and "Invitation code", Connect. Shellie makes the secret, signs up, stores the
   connection.
2. Connected: the last push, "Show QR code" (the code and "Copy link" are on screen only after that, and right
   after connecting **(call)**: the code is the key, and Settings is a screen people share), "Send now",
   Disconnect (asks first; removes the account and everything on the server). When the server cannot be reached,
   "Disconnect anyway" forgets the connection here and leaves the account on the server **(call)**.
3. Each brain has a switch "Send long reads and letters to my phone" (Settings › Project › Brains), off by
   default, shown once the phone is connected (and for a brain that has it on, so it can be switched off).

The QR code is drawn in the renderer with `qrcode-generator` (one small dependency, no network).

## The site (`reader/site`)

A React app, the mockups' look, system fonts (no font files from a third party) **(call)**.

- **No secret**: one screen. "Open the link from Shellie: Settings › User › Phone", and a field to paste the link
  (a site added to the home screen on iOS has its own storage and needs it once more).
- **Reading list**: the brain's name with "Switch brain" when there are several; a bar and "9 of 31 read · about 1
  h 50 min left"; the sections, each absent when empty:
  1. **For your work this sprint**: unread pieces with `work`.
  2. **Changed since you read it**: unread letters about a long read the person has marked read at some time,
     newest first; and long reads whose text changed since the mark and that have no such letter.
  3. **Foundations, in order**: the chapters' long reads in book order, read ones ticked, with "4 of 6".
  4. **Later**: long reads on a topic, and those whose chapter left the book. Closed until opened.
  A piece partly read shows how far ("40% read"). A letter about a long read never read is not listed: the long
  read says what holds now.
- **A long read**: back to the list, minutes left, a thin bar for the place in the text; the essay in a serif
  face; "Before you read on" with the answer held back; "What the writer was missing" closed; "Mark as read" at
  the end. The same parsing as in Shellie (`splitRead`, `splitLetter`).
- **A letter**: its parts labelled, what was read struck through, a link to the long read.
- **A cited page or source**: opens over the piece with its title and text, at the anchor when there is one; back
  returns to the place. One that was not sent says so. Web links open in a new tab.
- **Offline**: a service worker keeps the app's files; the items are kept, still encrypted, in IndexedDB.
- **Marks**: "Mark as read" writes the mark; the place in a text is kept on the phone only.
- "Forget this phone" in a small menu removes the secret and the kept items from the browser.

## Telemetry

`reader.connect` (ok or the kind of failure), `reader.disconnect`, `reader.push` (counts of items sent and removed,
ok or the kind of failure). Never an address, a title, a path, the reader id. The requests are not recorded as
dependencies **(call)**: a first push is hundreds of them, their paths hold item ids, and a `404` or `412` is an
ordinary answer that would read as a failure in the nightly health check. The site sends no telemetry.

## Deploying on aktse

`/opt/shellie-reader`: `docker-compose.yml` (stock `node:24-alpine`, the bundle mounted read-only, `./data` for
the accounts, joined to `adem_default`, host port on 127.0.0.1 only, CPU and memory limits, read-only root),
`.env` with `READER_INVITE`. No image is built: a deploy copies `reader/dist` over and restarts the service.
`docs/deploy-aktse.md` has the commands. The public hostname in the Cloudflare tunnel is the owner's step.

## Verification

- Unit tests: keys and sealing (round trip, wrong id, tampered blob), ids, the reading list's order, the server
  (every call, every refusal, limits, `If-Match`), the push (what is sent, changed, removed, the shelf last), the
  merge of marks, the site's screens.
- One test that runs the real server on a free port and pushes to it from Shellie's code, then reads it back with
  the site's code.
- In the dev app against the server on this machine, then against aktse.

## Known gaps on purpose

- No sprint section content until project 2.
- The secret sits in the phone browser's local storage, readable by any script the site serves.
- The server can hold back a newer item and serve an older one; the site would not notice.
- iOS can clear a site's storage after weeks without a visit: the link from Shellie brings it back.
- One machine pushes for a person **(call)**. A second machine connecting makes a second account with its own
  link; the phone holds one link at a time. Handing the secret from one machine to another is not built.
- No pictures: a picture in a text shows as its description.
- Not tried on a real phone before the merge: the site was driven in a desktop browser at a phone's size.
