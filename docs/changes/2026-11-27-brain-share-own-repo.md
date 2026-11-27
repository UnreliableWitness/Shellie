# Share a brain through a repo of your own (GitHub or any git host)

Asked for: share a brain with one colleague through a private GitHub repo the owner made, kept in step both ways
without thinking about it. Until now a shared brain could only live in an Azure DevOps repo that Shellie created
(`2026-11-13-shared-brains.md`), and Share could ask for a sync before sharing every time, for good. The owner asked to
skip the design round ("dive right in"), so there is no spec; the calls below are Claude's.

## What changed

- **A third home, `repo`** (`BrainSharing.home`, `src/shared/brain.ts`): a git repo named by its address. The Share
  dialog has a third choice, "A repo I made (GitHub or another git host)", with a **Repo address** field instead of a
  name. `shareBrain` (`share/share.ts`) makes no Azure DevOps call for it: it checks with `git ls-remote --heads` that
  this machine's git reaches the repo and that it has no branch yet, then pushes the same one fresh commit
  `Brain: shared` as `main`. The record keeps `https://<host>/<owner>` as the organization and the repo's name as the
  project (what the status line and "Shared on …" show) and an empty `repositoryId`.
- **Addresses** (`parseRepoUrl`, `src/shared/brainShare.ts`): `https://host/owner/repo[.git]`, `ssh://…` and
  `user@host:owner/repo`. Refused: http, an address with a user or password in an https URL, a query, a local path,
  `file://`, anything starting with `-` or holding a space. An Azure DevOps address is refused in this home (share and
  join say to use the Azure DevOps way).
- **Join** (`share/join.ts`): the join link of such a brain is `shellie://join?url=<address>`, and the address pasted
  as it is works too. `brain/origin.json` is read through a shallow clone without files in a scratch folder (git has
  no call for one file); then the usual join: the person's connection for the brain's project, the full clone,
  `Brain: joined`. No token is asked for or stored.
- **A place to paste it**: Settings › the project › Brains has "Join a shared brain", a field for a join link or a
  repo address that opens the join screen. The `shellie://` handler has never been seen working on Windows, so the
  link alone was not enough.
- **Sign-in**: for a repo outside Azure DevOps Shellie adds no header; git signs in as it does in a terminal on that
  machine (credential helper, or ssh in batch mode). A refusal reads "Git on this machine can't open <owner>/<repo>
  on <host>…" with what to do.
- **The same line endings on a joined brain**: every join clones with `core.autocrlf=false`, so git for Windows does
  not check the brain out with CRLF (the first of the two options in the shared-brains note's known gap; a brain
  shared from Windows is not changed).
- **The sync before a share no longer repeats for good**. Two causes:
  - `outsideEdits` (`health.ts`) read `git log -- wiki/` and stopped at the first `Brain: sync` commit, but a `/sync`
    that changed no page (only `brain/state.json` and `log.md`) is not in that log, so the hand edits before it stayed
    listed, on Health too, and Share asked for a sync again each time. It now reads every commit and keeps the files
    under `wiki/`.
  - `needsSync` now takes the end of the last `/sync` job that ended well this app session: with nothing committed to
    `sources/` or `wiki/` after it and nothing uncommitted in `wiki/`, no sync is asked for, whatever that sync wrote
    (a `/sync` that did not record `lastSyncCommit` asked for one before every share).
- Telemetry: `brain.share`'s `home` can be `repo` (`docs/telemetry.md`). Never the address.

## Decided without the owner

- The repo must be empty (made without a README): Share refuses one that has a branch, rather than writing over or
  merging into it.
- No token screen for GitHub: the machine's own git sign-in. Cheapest, and nothing new to store.
- The colleague still needs the brain's Azure DevOps project added in Shellie (the brain belongs to that project);
  join says "Add the … project in Shellie first" otherwise.
- "Stop sharing" says to delete the repo "on its host" for this home.

## Verified

`npm run typecheck`, `npm run lint`, and the touched tests (share, join, health, brainShare, the Share dialog,
brain handlers, settings): share to a bare repo standing in for the server, the refusals (not empty, not an address,
Azure DevOps, unreachable), join by address and by link with no Azure DevOps call, the two sync-loop cases, and the
address parser. On this Mac, `git ls-remote` with `GIT_TERMINAL_PROMPT=0` (as Shellie runs git) signed in to a
private GitHub repo.

## Known gaps

- **Not run against GitHub from the app, and not on Windows.** Git's sign-in from Shellie's console-less git on
  Windows (Git Credential Manager) is the open risk: if it cannot show its window, share and join say git can't open
  the repo; signing in once in a terminal (`gh auth login`, or any `git fetch` of a private repo) should then be
  enough, since the stored credential is reused.
- Not seen in the running app: the new dialog choice and the paste field are covered by render tests only.
- Join reads the repo twice before the full clone (the preview, then the join).
- The cause of the owner's own stuck Share was not confirmed on their brain (it is on another machine); both known
  ways into the loop are closed.
- A commit made in the same second a `/sync` ended counts as seen by it.
