# Shared brains

Date: 2026-11-13. Status: design, awaiting the owner's approval.

## Intent

Today a brain is one local git folder on one machine (`docs/changes/2026-11-03-brain.md`: "local (one git repo on this
machine, no remote)"; sharing was listed as a later phase, with `git remote add` as the only path). Colleagues who work
on the same customer project cannot use it, and cannot add to it.

The owner wants colleagues to **use and add to** the same brain: drop files in, run captures, and have their tasks'
Claude sessions and reading lists read the same wiki. It must be as easy as a click on both ends, and nobody should ever
see git.

Where the shared brain lives is a choice per brain: **in the customer's Azure DevOps project** (the brain's own
connection), or **in the company's own Azure DevOps organization** (a "brain home" set up once), so the customer need
not see it.

## Goals

- **Share** a brain in one dialog: pick where it lives, check what goes along, done.
- **Join** a shared brain in one click, offered to colleagues who have the same customer project in Shellie.
- **Everyone adds.** A colleague's drop is captured on their own machine, with their own agent, model and cost, and
  everyone else gets the result.
- **Sync without anyone thinking about it.** Pull and push happen on their own; a colleague's change and mine never end
  in a git conflict a person has to resolve.
- **Brain-wide automatic work runs once**, not once per member.

## Non-goals (v1)

- Merging two brains that already exist (mine and a colleague's for the same project). Join is for people without one.
- GitHub (or any other host) as a brain home. Azure DevOps only: Shellie already signs git in to Azure Repos with a PAT
  (`src/main/services/gitAuth.ts`). The home is modelled so another host can be added later.
- Managing who has access inside Shellie. Access is whatever Azure DevOps permissions say on the repo or project.
- Deleting the server repo from Shellie. Stopping sharing leaves it; deleting it is done in Azure DevOps.
- Live collaboration (seeing a colleague's job as it runs).

## Anti-goals (a failure even if it works)

- A person is ever shown a git conflict, a rebase or a merge to resolve.
- With the company home chosen, anything of the brain is written to the customer's organization.
- Every member's machine runs (and pays for) the same digest, book pass or long read.
- A secret, or a source the owner meant to keep out, reaches the server.
- Joining or syncing breaks the brain for the person who already had it.

## Constraints from the existing code

- A brain is tied to one connection by `connectionId` (`src/shared/brain.ts`, `BrainSchema`). A colleague's copy must
  be tied to **their** connection for the same customer organization and project, matched by `organizationUrl` +
  `project`.
- `brain/state.json` is committed and changed by every job, and holds a commit id (`lastSyncCommit`). History must not
  be rewritten under it: no rebase of commits another machine may have seen, and no rebase of local commits whose ids
  are recorded. Merges and fresh runs only.
- Already per machine and gitignored: `brain/lock`, `.mirror/`, OpenCode's node modules. The lock only guards one
  machine; across machines the server's push is the only arbiter.
- Every Shellie commit in a brain goes through `withBrainGit` (`gitMutex.ts`); sync joins that queue.
- Secrets are refused at drop time (`secrets.ts`), and `scrubBrain` (`scrub.ts`) can remove a value from the brain.
- `templatesVersion` is stored in `brains.json` per machine, but the skills are files in the repo; once shared, a
  colleague's push can change them.
- The daily token cap, model, agent, `sendToPhone` and the reading list are per person and stay that way.

## Approaches considered

- **A. Everyone runs their own jobs; a job that loses the race runs again** (chosen). Each person's Shellie captures
  what they add, then pushes. A push the server rejects because someone pushed first is resolved by pulling and, when
  the job's wiki changes clash, running the job again on the newer brain. Brain-wide automatic jobs run only on the
  keeper's machine. Trade-off: works when the owner's machine is off and cost lands with whoever added; the sync logic
  is the most involved, and a clash costs one extra run.
- **B. One keeper runs every job; colleagues only push sources.** No conflicts (new files never clash) and simple sync,
  but nothing is captured while the keeper's machine is off, all AI cost lands on the keeper, and colleagues wait.
  Kept in mind as a fallback.
- **C. Everyone keeps their own brain and only sources are exchanged.** Dropped: the wikis drift, every member pays to
  capture the same file, and it is not one brain.

The owner picked **A** on 2026-11-13.

## Design

### Where it lives: the home

Two kinds, chosen per brain when sharing:

- **Customer project.** The repo is created in the brain's own connection's project, with that connection's PAT.
- **Company brain home.** Set up once in Settings › User (a "Brain home" section): organization URL, project and a PAT
  with Code (read & write). It is **not** a project in Shellie: no Project page, no work items, no sprint. Its token is
  stored encrypted like connections' (safeStorage). One brain home per person in v1.

The share dialog defaults to the company brain home when one is set up (the customer project is the more visible
choice and should not be picked by accident), and says plainly which organization will hold the brain.

### What is shared, what is not

Shared (in the repo): `sources/`, `wiki/`, `reads/`, `index.md`, `log.md`, `SCHEMA.md`, `.claude/`, `.opencode/` commands,
`brain/state.json`, `brain/conflicts.json`, `brain/book.json` and the other `brain/*.json` the brain already commits,
plus the new `brain/origin.json`, `brain/members.json` and `brain/shared.json`.

Per person (in `brains.json` as today, never in the repo): name shown in the nav, path, options (model, agent, cap,
phone, terminal, automatic-job switches), archived, the passes' bookkeeping (`picturePass`, `bookPass`, `readsPass`).

`brain/origin.json`:

```json
{
  "format": 1,
  "organizationUrl": "https://dev.azure.com/contoso",
  "project": "Webshop",
  "name": "Webshop brain",
  "keeper": { "installId": "…", "name": "Dries" },
  "sharedAt": "2026-11-13T10:00:00Z"
}
```

It is how a colleague's Shellie knows which customer project the brain belongs to (essential for the company home,
where the repo is elsewhere) and whose machine is the keeper.

### Share

From the Brain page (and Settings › Brains), **Share with colleagues**:

1. **Where:** Company brain home (default when set up) or This customer project, with the organization named.
2. **Repo name:** defaulted from the brain's name, editable, with a line saying everyone with access to the home sees
   it (a customer name in a company repo name is visible company-wide).
3. **What goes along:** the list of sources. To keep one out, the person removes it first (the existing remove, which
   retracts it from the wiki); the dialog links there rather than inventing a second mechanism.
4. **Check:** the secrets scan (`findSecrets`) runs over the files to be pushed. Any hit stops the share and lists the
   files, with the existing scrub as the way forward.
5. **Push.** Shellie creates the repo through the Azure DevOps API, writes `brain/origin.json`, and pushes **one fresh
   commit** of the current tree (not the local history), so sources removed or scrubbed earlier, and old blobs, do not
   reach the server. The local brain is then moved onto that commit (its old history kept in a local ref until the next
   successful sync, then dropped), and `lastSyncCommit` is set to it.

The sharer becomes the keeper. The brain is marked shared in `brains.json` (`sharing`, below).

Before the push, if the brain has outside edits not yet synced or changes since `lastSyncCommit` (what Health already
shows), Share runs a `/sync` first and waits for it, so nothing the old history was needed for is lost. **(call)**

### Join

Two ways in:

- **Join link (the owner's choice, 2026-11-13).** After sharing, and any time later from the Brain page, **Copy join
  link** gives a `shellie://join?…` link holding the home organization, project and repository id (never a token). The
  sharer sends it however they like. Opening it in Shellie shows the brain's name and customer project (read from
  `origin.json`), asks for a PAT for that organization if no connection or brain home covers it, and joins. A token
  asked for here is saved as the person's brain home when they have none. **(call)** Someone without access gets Azure
  DevOps's answer in plain words ("You don't have access to this brain; ask Dries"), from the 401/403.
- **Card, for brains in the customer project.** A colleague with a connection to the same customer organization +
  project, and no brain for it, sees "Your team has a brain for Webshop. Join?" on the Project page and in the Brains
  nav, found by listing that project's repos with a `brain/origin.json` (cached per app session, refreshed when the
  Project page opens). It costs nothing to offer, since their connection already reaches that project. **(call)** No
  card is offered for the company home: the link is the way in there.

The join link needs Shellie registered as the handler of `shellie://` on Windows and macOS (Electron's
`setAsDefaultProtocolClient`, the `open-url` / second-instance events).

Join clones the repo into `<userData>/brains/<new id>`, creates the `Brain` record tied to **the colleague's**
connection, with default options, reads `templatesVersion` from the repo, and runs the usual adopt checks. A colleague
who already has a brain for the project sees the card with "You already have a brain for this project" and no Join in
v1 (merging is a non-goal); they can archive theirs and join.

### Sync

All sync runs inside the brain's `withBrainGit` queue and, for the job-related parts, under the brain lock.

**Pull** (fetch, then fast-forward or merge): when the app starts, before each job starts, when the Brain page opens, and
every 15 minutes while the app is open and the brain is idle. The working tree is always clean at that point (Shellie
already commits outside edits before a job).

**Push:** after every Shellie commit in a shared brain (source added, job output, outside edits, wiki mirror, template
update), so normally at most one commit is unpushed. Offline or unreachable: commits wait locally and go with the next
successful push.

**Secrets on every push.** Before each push, `findSecrets` runs over the text added in the commits being pushed. A hit
holds the push (and the ones after it, which stay local) with the status "Held: possible secret in \<file\>", and the
existing scrub is the way forward. On a shared brain, Scrub and Remove say that the server keeps whatever was already
pushed in its history, and that a real secret that got out must be rotated. **(call)**

**Nothing is ever rewritten.** History that left the machine, and commit ids recorded in `brain/state.json` or
`brain/reads.json`, stay valid because sync only fetches, merges and adds commits on top. No rebase, no dropping a
commit, no force push.

**When the server rejects a push** (someone pushed first), Shellie fetches and merges, however many local commits wait,
with rules per file so no person ever resolves anything. Git's ordinary three-way merge is accepted wherever it merges
cleanly, including two changes to different parts of the same wiki page **(call: runs again only on a real clash, to
keep them rare and cheap)**. The rules for what git cannot merge:

| Path | Rule |
|---|---|
| `sources/` (not the mirror) | New files never clash. Same path changed on both sides cannot happen (sources are never edited); if it does, keep both, the local one renamed. |
| `sources/wiki/` (the mirror) | Take the server's; the next refresh brings either side up to date. |
| `log.md` | Union (`.gitattributes merge=union`), newest-first order restored by Shellie. |
| `index.md` | Take either, then rebuild (Shellie owns it, `refreshIndex`). |
| `brain/state.json` | Shellie's own JSON merge: `captured` is the union (later `at` wins); `findings` from the side with the later `lastLintAt`; `lastSyncCommit` the one that is an ancestor of the other's, or the merge base if neither. |
| `brain/conflicts.json` | Per conflict id, the furthest state wins: settled over parked over open. `answers` is the union. |
| `brain/reads.json`, `brain/pictures-skipped.json`, `brain/pictures-dropped.json` | Maps: union by key; on the same key, the entry with the later `at` wins. |
| `brain/book.json` | The server's chapter order wins; chapters or pages only the local side added are appended to it. |
| `brain/shared.json` | Per field, the later timestamp wins. |
| `wiki/` and `reads/` (job output) | A real clash on a page or read whose local change came from a **job**: the server's version is taken for the clashing files, the merge is committed, and the job runs again on top (below). From an outside edit: the server's version is taken and the local text is added as a source (`sources/notes/…`) so a capture folds it in. |
| `SCHEMA.md`, `.claude/`, `.opencode/` | Take the higher templates version. |

**Running a job again.** When a merge takes the server's side of a clash for a job's output, Shellie puts the same
job back at the front of the queue (a capture with the same source, a `/write` with the same target). It runs on the
merged brain and its output is a new commit on top. The job card says "Ran again: a colleague changed the brain at the
same time." After two runs that both clash, the job fails with that message and a Retry, as failed jobs do today.

**A colleague's source left uncaptured.** If a pushed source is still not in `state.captured` an hour after it arrived
(its adder's machine went off mid-capture, say), the keeper's Shellie captures it. **(call)**

**Status** on the Brain page and the brain's nav row: "Shared · up to date", "Sending 3 changes", "Can't reach
\<home\> · 3 changes waiting", "Ran a capture again". A sync error never blocks local work.

### The keeper

The brain-wide automatic jobs run **only on the keeper's machine**: the weekly digest, `/sync` after a refresh, long
reads written on their own, the picture pass, the book pass, the scheduled wiki refresh. Anyone can still start any of
them by hand. Captures (and the lint each capture queues) run on the machine where the source was added.

The keeper is identified by an install id (one per Shellie install, created once and kept in user data) plus a display
name, in `origin.json`. On other machines the automatic-job switches show "Runs on Dries's Shellie". The keeper can hand
over (pick a member who has joined; members announce themselves by a line in `brain/members.json` when joining:
install id, name, joined at), and any member can **take over** after the keeper's machine has not pushed for 14 days,
with a confirmation.

**Shared brain-wide facts** go in a new committed `brain/shared.json`, so a new keeper can carry on and nothing runs
twice in one week: the customer wiki link (today's `Brain.wiki`, a `BrainWiki`), `lastRefreshAt` and `lastDigestAt`.
Each member refreshes the mirror with their own customer PAT. For a shared brain these fields are read from
`shared.json`, not `brains.json`. **(call)**

### Skills versions

After a pull, Shellie reads the brain's templates version from the repo, not from `brains.json`. A machine whose Shellie
knows an **older** templates version than the repo does not run jobs on that brain and says "A colleague's Shellie is
newer: update Shellie". Offering "Update skills" on a shared brain pushes the update to everyone, and the dialog says
so.

### Leaving and stopping

- **Leave** (member): the local copy is archived or deleted as today; the member's line in `members.json` is removed by
  a last push when reachable.
- **Stop sharing** (keeper): the brain becomes local again on this machine (remote removed). The repo stays on the
  server and other members keep syncing with each other; the keeper is told the repo must be deleted in Azure DevOps to
  end it for everyone.

### Data model changes

`Brain` gains `sharing`, null for a local brain:

```ts
sharing: {
  home: 'customer' | 'company';
  remoteUrl: string;
  repositoryId: string;
  joinedAt: string;
  lastPullAt: string | null;
  lastPushAt: string | null;
  status: 'ok' | 'pending' | 'unreachable' | 'unauthorized';
} | null
```

A brain home store (one record, token encrypted). The install id in user data.

### Telemetry and cost

New events `brain.share`, `brain.join`, `brain.sync` (outcome, replays count, no names), listed in `docs/telemetry.md`.
Cost does not change: each person's jobs are priced on their own machine and ledger, attributed to their local brain's
pseudo task id.

## Decided

By the owner (2026-11-13): colleagues add to the brain, not only read it; approach A; the home is a choice per brain
(customer project or company organization); joining a company-home brain is by a join link.

My calls, marked **(call)** above, for the owner to check: the company home as the dialog's default; `/sync` before
sharing; secrets checked on every push and held; git's clean merge accepted inside a page, a run again only on a real
clash; the merge rules for each `brain/*.json`; the wiki link and digest dates shared in `brain/shared.json`; the
keeper capturing a colleague's source left uncaptured after an hour; the card offered for customer-project brains; a
token asked for by a join link becoming the brain home; one fresh commit at share time; install id as the keeper's
identity; take-over after 14 days without a push.

## Left to the builder

- Where the brain home lives in Settings › User and its exact form; reuse the connection form and test call where it
  fits.
- The Azure DevOps calls (create repo, list repos, read one file at the default branch) and their error messages.
- How the merge rules are implemented (merge drivers in `.gitattributes`, or Shellie resolving the conflicted files
  itself after `git merge`), as long as no conflict ever reaches a person.
- The exact copy of the cards and status lines, in the app's usual voice.
- Test setup: a bare repo standing in for the server, two brain folders standing in for two machines.

## Open risks

- The merge rules are the riskiest part. They need tests that interleave two machines' commits for every row of the
  table, including a pull in the middle of a job.
- Members on very different Shellie versions: the "update Shellie" stop covers skills, not other format changes;
  `origin.json` and `members.json` carry a `format` number for that reason.
- Windows: git runs through `GitClient` as today; unverified until run there.
