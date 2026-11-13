# Shared brains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Colleagues share one brain through an Azure DevOps git repo (in the customer project or the company's brain home), join it by link or card, and add to it, with sync that never shows a person a git conflict.

**Architecture:** A new `src/main/brain/share/` module owns everything shared: the committed share files (`origin.json`, `members.json`, `shared.json`), pure JSON/log mergers, a git-level merge that resolves every conflicted path by rule, a `BrainSync` service that pulls before jobs and on a timer and pushes after every brain commit (via a listener on `withBrainGit`), and the share and join flows. The job runner gains "run again at the front"; the scheduler gains a keeper gate. The renderer gets a brain home section, a share dialog, a join screen opened by `shellie://join`, a project card and a status line.

**Tech Stack:** Electron, TypeScript, zod, git CLI via `GitClient`, Azure DevOps REST via `AdoClient`, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-shared-brains-design.md` (read it first; this plan argues from it).

## Global Constraints

- Never rewrite history that may have left the machine: no rebase, no reset of pushed commits, no force push. Sync only fetches, merges and adds commits.
- No person ever sees a git conflict; every conflicted path is resolved by the rule table in the spec.
- With the company home, nothing of the brain goes to the customer organization.
- Tokens never on a command line or in a log: git auth goes through `GitClient`'s `GitAuth` (`extraHeaderEnv`), stored tokens through `TokenCrypto` (safeStorage), as `ConnectionStore` does.
- Every new file under `src/main` gets a colocated `*.test.ts`; git tests use a bare repo as the server and two clones as two machines (temp dirs).
- Pull timer 15 min (`TICK_MS` of the scheduler); push debounce 2 s; uncaptured colleague source picked up after 1 h; take-over after 14 days without a keeper push; a job clashes at most twice, then fails with "Ran again: a colleague changed the brain at the same time" and Retry.
- Share files carry `"format": 1`.
- Windows is the release target: paths through `path`, git through `GitClient`; the `shellie://` handler works on both (`setAsDefaultProtocolClient`, `open-url` on macOS, `second-instance` argv on Windows).
- `npm test`, `npm run typecheck`, `npm run lint` green at every commit.
- Telemetry: new events listed in `docs/telemetry.md`, no names, paths or URLs in properties.
- Copy in the app's voice: short, plain, sentence case.

## Review Focus

1. **A pull while a job runs** (timer or page open fires mid-job): the pull must wait for the brain lock or skip, never merge under a running agent. Test in Task 6.
2. **Offline with several unpushed commits** (source, capture, outside edit, capture), then reconnect: one merge resolves all; only the clashing jobs run again. Test in Task 6.
3. **Push held for a secret, then the person scrubs**: the held push resumes and the scrubbed text was never pushed. Test in Task 6.
4. **Join link opened when the colleague has no connection for the customer project, or no access to the home**: a plain message, nothing cloned, no half-made brain record. Test in Task 8.
5. **A colleague's Shellie older than the brain's skills**: jobs held with "A colleague's Shellie is newer: update Shellie", sync still works. Test in Task 9.

---

### Task 1: Share files, types and the install id

**Files:**
- Create: `src/shared/brainShare.ts`, `src/main/brain/share/files.ts`, `src/main/installId.ts`
- Modify: `src/shared/brain.ts` (`BrainSchema` gains `sharing`)
- Test: `src/shared/brainShare.test.ts`, `src/main/brain/share/files.test.ts`, `src/main/installId.test.ts`

**Interfaces:**
- Produces (`src/shared/brainShare.ts`):
  - `BrainSharingSchema` / `BrainSharing`: `{ home: 'customer' | 'company'; remoteUrl: string; repositoryId: string; homeOrganizationUrl: string; homeProject: string; joinedAt: string; lastPullAt: string | null; lastPushAt: string | null; status: 'ok' | 'pending' | 'held' | 'unreachable' | 'unauthorized'; heldFile: string | null }`; `BrainSchema.sharing` is `BrainSharingSchema.nullable().default(null)`.
  - `OriginSchema` / `Origin`: `{ format: 1; organizationUrl; project; name; keeper: { installId; name }; sharedAt }`.
  - `MembersSchema` / `Members`: `{ format: 1; members: { installId; name; joinedAt }[] }`.
  - `SharedFactsSchema` / `SharedFacts`: `{ format: 1; wiki: BrainWiki | null; lastRefreshAt: string | null; lastDigestAt: string | null; templatesVersion: number; updatedAt: Record<'wiki'|'lastRefreshAt'|'lastDigestAt'|'templatesVersion', string> }` (per-field timestamps for the merge).
  - `joinLink(o: { organizationUrl: string; project: string; repositoryId: string }): string` → `shellie://join?org=<enc>&project=<enc>&repo=<id>`; `parseJoinLink(url: string): { organizationUrl; project; repositoryId } | null` (null for anything else, including non-https org URLs).
  - `isKeeper(origin: Origin, installId: string): boolean`.
- Produces (`files.ts`): `readOrigin(dir) / writeOrigin(dir, o)`, `readMembers / upsertMember(dir, m) / removeMember(dir, installId)`, `readShared / writeShared(dir, patch: Partial<Omit<SharedFacts,'format'|'updatedAt'>>, now: Date)` (stamps `updatedAt` for each field written). Paths `brain/origin.json`, `brain/members.json`, `brain/shared.json`; read returns null when missing; zod-parsed.
- Produces (`installId.ts`): `getInstallId(userData: string): Promise<string>`: a UUID kept in `<userData>/install-id`, created once.

- [ ] **Step 1: Write failing tests**: `joinLink`/`parseJoinLink` round-trip with an org URL holding spaces and `&`; `parseJoinLink('https://x')` and `shellie://join?org=http://evil` are null; `BrainSchema.parse` of an old brain gives `sharing: null`; `writeShared` stamps only the fields given; `getInstallId` returns the same id twice and a new one in another folder.
- [ ] **Step 2: Run** `npx vitest run src/shared/brainShare.test.ts src/main/brain/share/files.test.ts src/main/installId.test.ts`, expect FAIL (modules missing).
- [ ] **Step 3: Implement** the three modules and the schema field.
- [ ] **Step 4: Run** the same command, expect PASS; then `npm run typecheck`.
- [ ] **Step 5: Commit** `git commit -m "Shared brains: share files, types and install id"`.

### Task 2: Brain home store and git auth for it

**Files:**
- Create: `src/main/brain/share/BrainHomeStore.ts`
- Modify: `src/main/services/gitAuth.ts` (`createGitAuth` deps), `src/main.ts` (store load, auth wiring), `src/shared/ipc.ts` + `src/main/brain/brainHandlers.ts` (IPC), `src/preload.ts` if channels are listed there
- Test: `src/main/brain/share/BrainHomeStore.test.ts`, `src/main/services/gitAuth.test.ts`

**Interfaces:**
- Produces: `BrainHome = { organizationUrl: string; project: string; user: string | null }`; `class BrainHomeStore { constructor(filePath, crypto: TokenCrypto); load(); get(): BrainHome | null; save(i: { organizationUrl; project; pat }): Promise<BrainHome>; token(): Promise<string>; remove(): Promise<void> }`, file `<userData>/brain-home.json`, token as ciphertext like `ConnectionsFileSchema`. `save` verifies with `AdoClient.verify` and `projects()` that the project exists (reuse `ConnectionStore.normalizeUrl` rules).
- Produces: `BRAIN_HOME_CONNECTION_ID = 'brain-home'`. `createGitAuth` keeps its shape; main passes `connections: () => [...connections.list(), ...homeAsConnection()]` and `token: (id) => id === BRAIN_HOME_CONNECTION_ID ? home.token() : connections.token(id)`, and `connectionIdFor(cwd)` returns, for a brain folder, `brain.sharing?.home === 'company' ? BRAIN_HOME_CONNECTION_ID : brain.connectionId`.
- Produces IPC: `brainHome:get` → `BrainHome | null`, `brainHome:save` (input `{ organizationUrl; project; pat }`) → `BrainHome`, `brainHome:remove` → `void`.

- [ ] **Step 1: Write failing tests**: save → get without the token, token decrypts; a bad URL or unknown project rejects and saves nothing; `createGitAuth` given a brain folder with company home picks the home's token even when a customer connection is in the same org.
- [ ] **Step 2: Run** `npx vitest run src/main/brain/share/BrainHomeStore.test.ts src/main/services/gitAuth.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** the store, the IPC handlers, and the main.ts wiring.
- [ ] **Step 4: Run** the tests, expect PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `"Shared brains: brain home store and its git sign-in"`.

### Task 3: Azure DevOps repo calls

**Files:**
- Modify: `src/main/services/AdoClient.ts`
- Test: `src/main/services/AdoClient.test.ts`

**Interfaces:**
- Produces:
  - `createRepository(project: string, name: string): Promise<{ id: string; remoteUrl: string }>` (POST `/{project}/_apis/git/repositories`, needs the project id from `projects()`; `{ write: true, code: true }` so a 401/403 gives `CODE_WRITE_DENIED`). A 409 (name taken) throws `AdoError('conflict', …, 'A repo with that name already exists in <project>')`.
  - `repositories(project: string): Promise<{ id; name; remoteUrl; defaultBranch: string | null }[]>`.
  - `repositoryById(id: string): Promise<{ id; name; remoteUrl; project: string; defaultBranch: string | null }>`.
  - `itemText(project: string, repositoryId: string, path: string): Promise<string | null>` (items API, `includeContent=true`, default branch; 404 → null).

- [ ] **Step 1: Write failing tests** with the existing fetch fake: the request URLs and bodies; 409 message; 403 on create gives the code-write message; `itemText` 404 → null; an empty repo (no default branch) → `defaultBranch: null` and `itemText` null.
- [ ] **Step 2: Run** `npx vitest run src/main/services/AdoClient.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** the four methods with `request`.
- [ ] **Step 4: Run**, expect PASS.
- [ ] **Step 5: Commit** `"Shared brains: Azure DevOps repo calls"`.

### Task 4: Pure mergers

**Files:**
- Create: `src/main/brain/share/jsonMerge.ts`
- Test: `src/main/brain/share/jsonMerge.test.ts`

**Interfaces:**
- Produces (all pure, three-way where a base helps; `base` may be null for files new on both sides):
  - `mergeLog(base: string | null, ours: string, theirs: string): string`: union of entries, newest first, no duplicate entries (an entry is a `## ` block of `log.md`).
  - `mergeState(base, ours: BrainState, theirs: BrainState, isAncestor: (a: string, b: string) => boolean): BrainState`: `captured` union, later `at` wins; `findings` and `lastLintAt` from the side with the later `lastLintAt`; `lastSyncCommit`: the descendant when one is an ancestor of the other, else `base.lastSyncCommit`.
  - `mergeConflicts(ours: BrainConflicts-file, theirs): …`: per id the furthest state wins (settled > parked > open; a row is removed from the lists it is not in), `answers` union.
  - `mergeKeyedMap<T extends { at?: string }>(ours: Record<string,T>, theirs: Record<string,T>): Record<string,T>`: union, later `at` wins (used for `reads.json`, `pictures-skipped.json`, `pictures-dropped.json`).
  - `mergeBook(ours: Book, theirs: Book): Book`: theirs' order; chapters and pages only in ours appended in ours' order. (Use the `book.json` type in `src/main/brain/book.ts`.)
  - `mergeShared(ours: SharedFacts, theirs: SharedFacts): SharedFacts`: per field, later `updatedAt` wins.
  - `mergeMembers(ours, theirs)`: union by `installId`, earlier `joinedAt` kept.

- [ ] **Step 1: Write failing tests**, one per function plus: the conflict settled on one side and still open on the other ends settled; two `captured` entries for the same source keep the later; `mergeState` with divergent `lastSyncCommit`s falls back to base; `mergeLog` keeps both sides' new entries and the order is newest first.
- [ ] **Step 2: Run** `npx vitest run src/main/brain/share/jsonMerge.test.ts`, expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, expect PASS.
- [ ] **Step 5: Commit** `"Shared brains: mergers for the brain's own files"`.

### Task 5: The git merge that resolves everything

**Files:**
- Create: `src/main/brain/share/merge.ts`
- Modify: `src/main/brain/brainHandlers.ts` (the write job's commit message carries its target: `Brain: write <target>`; find where the subject is built, `jobs.ts` `runSkill`)
- Test: `src/main/brain/share/merge.test.ts`

**Interfaces:**
- Consumes: Task 4's mergers.
- Produces:
  - `type JobRef = { kind: BrainJobKind; source: string | null; target: string | null }`; `parseJobSubject(subject: string): JobRef | null` (`Brain: capture sources/a.md` → capture with source; `Brain: write reads/x.md` → write with target; `Brain: <kind>` → no source; non-`Brain:` subjects and `Brain: index`, `Brain: settle conflict` etc. that are not job kinds → null).
  - `mergeServer(git: GitClient, dir: string, ref: string /* 'origin/main' */): Promise<{ merged: boolean; rerun: JobRef[]; notes: string[] }>`: runs inside the caller's `withBrainGit`. `git merge --no-ff --no-commit <ref>`; for each conflicted path, apply the spec's table; then `git commit -m "Brain: merge from colleagues"`. For `wiki/` and `reads/` clashes: take theirs (`git checkout --theirs`), find the local commits since the merge base touching the path (`git log <base>..HEAD --format=%s -- <path>`), job subjects go to `rerun` (deduplicated), outside-edit text is written to `sources/notes/<yyyy-mm-dd>-<page-slug>-local.md` and listed in `notes`. `sources/` clash: keep both, local renamed `<name>-local<ext>`. `sources/wiki/`: theirs. `index.md`: theirs, then `rebuildIndex`. Skills files: the side whose `shared.json` `templatesVersion` is higher. Nothing to merge (already up to date) → `{ merged: false, … }`. A fast-forward is allowed.
  - Throws only on git failures unrelated to conflicts; on a throw, it runs `git merge --abort` first so the tree is clean.

- [ ] **Step 1: Write failing tests** with a bare repo and two clones A and B of a scaffolded brain (use the scaffold helper the brain tests use): (a) A adds a source, B adds another: clean merge; (b) A and B both run a "capture" that edits `wiki/x.md` on the same line: theirs kept, `rerun` = A's capture; (c) same page, different paragraphs: git merges it, `rerun` empty; (d) outside edit vs job on the same page: note source written; (e) `log.md`, `state.json`, `conflicts.json`, `book.json` changed on both: merged by rule, no conflict markers anywhere in the tree (`git grep -n '^<<<<<<<'` empty); (f) three local commits (source, capture, outside edit) vs one server commit: one merge commit, only the capture in `rerun`; (g) `parseJobSubject` cases above.
- [ ] **Step 2: Run** `npx vitest run src/main/brain/share/merge.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** `merge.ts` and the write subject change.
- [ ] **Step 4: Run** it plus `npx vitest run src/main/brain`, expect PASS.
- [ ] **Step 5: Commit** `"Shared brains: merge from colleagues without conflicts"`.

### Task 6: BrainSync (pull, push, held secrets, run again)

**Files:**
- Create: `src/main/brain/share/BrainSync.ts`
- Modify: `src/main/brain/gitMutex.ts` (listener), `src/main/brain/jobs.ts` (`enqueue` options `front?: boolean`, `replays?: number`; `BrainJob.replays: number`), `src/main.ts` (wiring), `src/shared/ipc.ts` + `brainHandlers.ts` (`brain:syncNow`), broadcasts `brain:changed`
- Test: `src/main/brain/share/BrainSync.test.ts`, `src/main/brain/jobs.test.ts`, `src/main/brain/gitMutex.test.ts` (create if missing)

**Interfaces:**
- Consumes: `mergeServer`, `parseJobSubject`, `findSecrets`, `BrainStore.patch`, `BrainJobRunner.enqueue`, `acquireLock`/`releaseLock`.
- Produces:
  - `onBrainGitIdle(listener: (dir: string) => void): () => void` in `gitMutex.ts`: called after each `withBrainGit` callback settles, once the folder's queue is empty.
  - `class BrainSync { constructor(d: { brains: BrainStore; git: GitClient; runner: () => BrainJobRunner; changed: (brainId: string) => void; now?: () => Date; pushDelayMs?: number /* 2000 */ }); pull(brainId: string, o?: { lockHeld?: boolean }): Promise<void>; push(brainId: string): Promise<void>; afterGit(dir: string): void /* debounced push for a shared brain */; start(): () => void /* pull all shared brains now and every 15 min when idle */ }`.
  - `pull`: skips (no error) when the brain lock is held by a job and `lockHeld` is not set; fetch `origin`; `mergeServer` inside `withBrainGit`; each `rerun` ref → `runner.enqueue(id, kind, source, { front: true, target, replays: prev + 1 })`; a ref already replayed twice is not queued again and the job record fails with the spec's message; patch `sharing.lastPullAt`, `status`.
  - `push`: if HEAD is ahead of `origin/main`, scan the added lines of `git diff origin/main..HEAD` with `findSecrets`; a hit sets `status: 'held'`, `heldFile`, and does not push. Else `git push origin HEAD:main`; rejected → `pull` then push once more; network error → `status: 'unreachable'` (commits stay); `GitAuthError` → `'unauthorized'`.
  - Runner wiring in main.ts: `beforeJob` calls `sync.pull(id, { lockHeld: true })` before `commitJobOutput`; `onBrainGitIdle(sync.afterGit)`.
  - Keeper pick-up (in `pull`, keeper only): sources under `sources/` (not `sources/wiki/`) absent from `state.captured`, whose last commit time (`git log -1 --format=%ct -- <path>`) is over 1 h ago and with no queued job for them → `enqueue(id, 'capture', path, { background: true })`.

- [ ] **Step 1: Write failing tests** (bare repo + two clones, a fake runner recording `enqueue` calls): push after a source commit reaches the server within the debounce; a rejected push merges and pushes; a clash enqueues the capture at the front with `replays: 1`; a third clash fails it with "Ran again: a colleague changed the brain at the same time"; a held secret blocks the push and sets `heldFile`, and after the line is scrubbed (a new commit removing it and the original commit still local → the diff no longer adds it) the push goes; a pull while the lock is held by another job is skipped and leaves the tree untouched (Review Focus 1); offline (bare repo moved away) with four local commits, then back: one merge, only clashing jobs re-queued (Review Focus 2); `enqueue({ front: true })` puts the job before older queued ones; the keeper picks up a colleague's source uncaptured for 61 min and not one for 59 min.
- [ ] **Step 2: Run** `npx vitest run src/main/brain/share/BrainSync.test.ts src/main/brain/jobs.test.ts src/main/brain/gitMutex.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** `BrainSync`, the listener, the runner options, the IPC and main.ts wiring.
- [ ] **Step 4: Run**, then `npm test`, expect PASS.
- [ ] **Step 5: Commit** `"Shared brains: sync after every commit and before every job"`.

### Task 7: Share

**Files:**
- Create: `src/main/brain/share/share.ts`
- Modify: `src/shared/ipc.ts`, `brainHandlers.ts` (`brain:share`, `brain:joinLink`, `brain:stopSharing`)
- Test: `src/main/brain/share/share.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3, 6; `findSecrets`; `BrainJobRunner`; Health's "outside edits / changes since lastSyncCommit" (the function behind `brain:health` in `health.ts`).
- Produces:
  - `shareBrain(d: ShareDeps, i: { brainId: string; home: 'customer' | 'company'; repoName: string }): Promise<{ status: 'shared'; joinLink: string } | { status: 'secrets'; files: string[] } | { status: 'syncing' }>`. Order: not already shared (else throw `Already shared`); pending outside edits or changes since `lastSyncCommit` → enqueue `sync` and return `syncing` (the renderer calls again when the job is done); secrets scan over every tracked text file → `secrets`; create the repo (home's or the brain's connection client); write `origin.json` (keeper = this install, name from the connection's `user`), `members.json` (this install), `shared.json` (wiki, lastRefreshAt, lastDigestAt, templatesVersion from the brain record); keep the old history as `refs/shellie/pre-share`; one orphan commit `Brain: shared` of the tree; `lastSyncCommit` set to it (amend before push is fine: nothing has left yet); add `origin`, `git push -u origin HEAD:main`; patch `sharing`. A failure after the repo was created leaves the brain local and unchanged (restore `refs/shellie/pre-share` as the branch) and the message says the empty repo can be deleted in Azure DevOps.
  - `stopSharing(d, brainId)`: remove `origin`, `sharing: null`, origin.json kept.
  - `brain:joinLink` → `joinLink({ organizationUrl: home org, project: home project, repositoryId })`.
  - `refs/shellie/pre-share` deleted after the first successful pull.

- [ ] **Step 1: Write failing tests** with a fake AdoClient pointing `remoteUrl` at a bare repo: share pushes exactly one commit containing the tree and the three share files and no source removed earlier (its blob absent from the bare repo: `git cat-file -e` fails); a secret in a wiki page returns `secrets` and creates no repo; pending outside edits return `syncing` and enqueue one `sync`; a push failure restores the old branch and `sharing` stays null; company home creates the repo through the home client, customer home through the connection's.
- [ ] **Step 2: Run** `npx vitest run src/main/brain/share/share.test.ts`, expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, expect PASS.
- [ ] **Step 5: Commit** `"Shared brains: share a brain"`.

### Task 8: Join (link, card, protocol)

**Files:**
- Create: `src/main/brain/share/join.ts`
- Modify: `src/main.ts` (protocol registration, `open-url`, `second-instance` argv, a pending link delivered once the window loads via `brain:openJoin` broadcast), `forge.config.mts` (`packagerConfig.protocols: [{ name: 'Shellie', schemes: ['shellie'] }]`; the Windows installer maker's protocol option if it has one), `src/shared/ipc.ts`, `brainHandlers.ts`
- Test: `src/main/brain/share/join.test.ts`

**Interfaces:**
- Produces:
  - `previewJoin(d, link: string): Promise<{ name: string; organizationUrl: string; project: string; connectionId: string | null; needsToken: boolean; alreadyHave: boolean }>`: parses, finds a token (a connection in the link's org, or the brain home), reads `origin.json` with `itemText`; `connectionId` is the person's connection for origin's org + project (null → the renderer says "Add the <project> project in Shellie first"); 401/403 → `AdoError` whose message the renderer shows as "You don't have access to this brain; ask <keeper name>" when the keeper name is known, else Azure DevOps's words.
  - `joinBrain(d, link: string, o: { pat?: string }): Promise<Brain>`: a `pat` given is saved as the brain home when there is none; clones into `<userData>/brains/<new id>`; creates the `Brain` with the person's `connectionId`, `wiki`/`lastRefreshAt`/`lastDigestAt`/`templatesVersion` from `shared.json`, default options, `sharing` set; `upsertMember` and commit `Brain: joined` (pushed by sync). Any failure removes the clone folder and creates no record.
  - `discoverCustomerBrains(d, connectionId): Promise<{ repositoryId; name; joinLink }[]>`: repos of that project with an `origin.json` whose org + project match; cached per app session per connection.
  - IPC: `brain:previewJoin`, `brain:join`, `brain:discover`.

- [ ] **Step 1: Write failing tests**: preview with no matching connection → `connectionId: null`, nothing written; 403 → the access message with the keeper name; join clones, record has the person's connection id and shared facts; join failure mid-clone leaves no folder and no record (Review Focus 4); a link with a new PAT and no home saves the home; `alreadyHave` when a brain exists for that connection + project; discover lists only matching repos and caches.
- [ ] **Step 2: Run** `npx vitest run src/main/brain/share/join.test.ts`, expect FAIL.
- [ ] **Step 3: Implement**, including the protocol wiring in main.ts and forge config.
- [ ] **Step 4: Run**, expect PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `"Shared brains: join by link or card"`.

### Task 9: Keeper, shared facts and skills version

**Files:**
- Modify: `src/main/brain/scheduler.ts` (dep `automatic: (id: string) => boolean`), `src/main.ts` (digest/refresh patch paths), `src/main/brain/brainHandlers.ts` (`brain:refresh`, `brain:updateTemplates`, new `brain:handOver`, `brain:takeOver`), `src/main/brain/share/BrainSync.ts` (after pull: copy shared facts into the record; skills version check)
- Test: `src/main/brain/scheduler.test.ts`, `src/main/brain/share/keeper.test.ts`

**Interfaces:**
- Produces:
  - `automatic(id)`: true for a local brain or when `isKeeper(origin, installId)`. The scheduler skips refresh, digest, picture pass, book pass and reads pass when false. Hand-started jobs are unaffected.
  - On a shared brain, writing `wiki`, `lastRefreshAt`, `lastDigestAt` or `templatesVersion` also calls `writeShared` and commits `Brain: shared facts` (through `withBrainGit`, so it is pushed). After each pull, `BrainSync` patches those four fields from `shared.json` into the record.
  - Skills check: after a pull, if `shared.templatesVersion > TEMPLATES_VERSION`, the runner's `ready(id)` is false and `sharing.status` stays as is; the Brain page shows "A colleague's Shellie is newer: update Shellie". `brain:updateTemplates` on a shared brain works as today and writes `templatesVersion` to `shared.json`.
  - `brain:handOver(id, installId)`: keeper only, target must be in `members.json`; writes `origin.keeper`, commits `Brain: keeper`. `brain:takeOver(id)`: allowed when the keeper has not pushed for over 14 days. To know that, every commit Shellie makes in a shared brain gets a trailer `Shellie-Install: <installId>` (`git commit --trailer`); take-over finds the newest commit on `origin/main` with the keeper's id (`git log -1 --format=%ct --grep='Shellie-Install: <id>' origin/main`) and compares its time with now. No such commit counts as the share commit's time.

- [ ] **Step 1: Write failing tests**: scheduler with `automatic` false does not refresh, digest or start passes; a digest on the keeper writes `lastDigestAt` to `shared.json`, and a member's pull copies it so a later keeper never digests twice that week; a member with `TEMPLATES_VERSION` lower than `shared.json` has `ready` false, and its pull still works (Review Focus 5); hand-over to a non-member throws; take-over refused when the keeper's newest trailer commit is 13 days old, allowed at 15.
- [ ] **Step 2: Run** `npx vitest run src/main/brain/scheduler.test.ts src/main/brain/share/keeper.test.ts`, expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test`, expect PASS.
- [ ] **Step 5: Commit** `"Shared brains: keeper, shared facts and skills version"`.

### Task 10: Renderer: brain home, share dialog, status, join screen, card

**Files:**
- Create: `src/renderer/components/settings/BrainHomeSection.tsx`, `src/renderer/components/brain/ShareDialog.tsx`, `src/renderer/components/brain/SharedStatus.tsx`, `src/renderer/screens/BrainJoinScreen.tsx`, `src/renderer/components/brain/JoinCard.tsx`
- Modify: `src/renderer/components/settings/UserScope.tsx` (section), `src/renderer/components/brain/BrainPage.tsx` (Share button, status, Copy join link, keeper and Stop sharing in the brain's settings card), `src/renderer/screens/ProjectScreen.tsx` and the Brains nav (card), `src/renderer/App.tsx` (route for `brain:openJoin`), the Scrub and Remove dialogs (shared warning), `src/renderer/components/settings/BrainsSection.tsx` (automatic switches show "Runs on <keeper>'s Shellie" for members), `src/renderer/api.ts`
- Test: colocated `*.test.tsx` for each new component, plus `BrainPage.test.tsx`, `ProjectScreen.test.tsx`

**Interfaces:**
- Consumes: IPC from Tasks 2, 6-9.
- Copy (exact):
  - Share button: "Share with colleagues". Dialog where-options: "Company brain home (<org>)" (default when set up) and "This customer project (<org>/<project>)"; repo name hint: "Everyone with access to <org> sees this name."; sources line: "Everything in Sources goes along. To keep one out, remove it first." with a link to Sources; secrets result: "Possible secrets in these files. Scrub them, then share." listing files.
  - Status: "Shared · up to date", "Sending <n> changes", "Can't reach <org> · <n> changes waiting", "Held: possible secret in <file>", "Ran a capture again".
  - Card: "Your team has a brain for <project>. Join?"; already have: "You already have a brain for this project."
  - Join screen: "<name>, the brain for <project>"; no connection: "Add the <project> project in Shellie first."; token field shown when `needsToken`.
  - Scrub/Remove on a shared brain: "This brain is shared. The server keeps what was already sent in its history; a real secret that got out must be changed."
  - Member switches: "Runs on <keeper name>'s Shellie".
  - Newer skills: "A colleague's Shellie is newer: update Shellie."

- [ ] **Step 1: Write failing tests**: dialog defaults to company home when one is set and to the customer project otherwise; `syncing` result shows "Syncing first…" and re-calls share when the brain's sync job ends; secrets list renders; status line text per status; card shows only when `discover` returns a brain and no local brain exists; join screen states (no connection, token needed, access denied, joined → navigates to the brain); shared warning appears in Scrub and Remove only when `sharing` is set.
- [ ] **Step 2: Run** `npx vitest run src/renderer`, expect FAIL.
- [ ] **Step 3: Implement**, following the mockups' existing patterns (`design/mockups/`) and the Brain page's existing cards.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run lint`, expect PASS.
- [ ] **Step 5: Commit** `"Shared brains: share, join and status in the app"`.

### Task 11: Telemetry, docs, and a two-machine check in the running app

**Files:**
- Modify: `src/main/brain/brainTelemetry.ts` (events), `docs/telemetry.md`
- Create: `docs/changes/2026-11-13-shared-brains.md`
- Test: `src/main/brain/brainTelemetry` tests if present, else assertions in `BrainSync.test.ts`

**Interfaces:**
- Produces events: `brain.share` `{ home: 'customer' | 'company', outcome: 'shared' | 'secrets' | 'syncing' | 'failed' }`, `brain.join` `{ via: 'link' | 'card', outcome: 'joined' | 'noConnection' | 'denied' | 'failed' }`, `brain.sync` `{ outcome: 'pushed' | 'merged' | 'held' | 'unreachable' | 'unauthorized', replays: number }` (sent at most once per brain per pull/push, no names).

- [ ] **Step 1: Write failing tests** that the three events fire with only these properties.
- [ ] **Step 2: Run**, expect FAIL; **Step 3: Implement**; **Step 4: Run**, expect PASS.
- [ ] **Step 5: Running-app check**: two dev instances on separate data folders (`SHELLIE_USER_DATA=<a> npm start -- -- --remote-debugging-port=<p1> --use-mock-keychain`, same for `<b>`), a local bare repo standing in for the server (set as the remote by a test-only override, or a real repo in `unreliablewitness/Shellie` if a PAT is available from the Keychain account `shellie`). A fake `claude` first on PATH that writes a page and logs its arguments (no tokens spent). Check: share from A, join from B by link, add a source on each, both see both; force a clash and see "Ran a capture again". Record what was and was not verified.
- [ ] **Step 6: Write the change note** (spec followed, how it works, what was verified, known gaps: Windows protocol handler unverified until run there; GitHub homes not supported; merging two existing brains not supported) and update `docs/telemetry.md`.
- [ ] **Step 7: Run** `npm test`, `npm run typecheck`, `npm run lint`; **Commit** `"Shared brains: telemetry, change note and running-app check"`.
