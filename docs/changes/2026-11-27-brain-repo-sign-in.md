# A repo home signs in with the right account by itself

Asked for: sharing a brain to a private GitHub repo (`2026-11-27-brain-share-own-repo.md`) failed for the owner, who is
signed in to GitHub with two accounts; make it work and make onboarding easier. The first version used only git as it
is on the machine, and git's credential helper keeps one login per host: with the personal account stored, GitHub
answers "Repository not found" for the work repo. No spec; the owner asked for speed.

## What changed

- **The sign-in is searched for** (`findSignIn`, `src/main/brain/share/repoSignIn.ts`), at share and at join, with
  `git ls-remote --heads`:
  1. git as it is on the machine;
  2. when that is refused or "not found" on an https repo: each account the GitHub CLI is logged in to for that host
     (`gh auth status --json hosts`, the active one first), with its token (`gh auth token --hostname … --user …`);
  3. when nothing opens it: a **token** is asked for, in the Share dialog (`needsToken`) and on the join screen (the
     token step it already had, with words for a repo).
  A failure that is not about access (offline, a wrong host) is reported at once; a repo over ssh has no step 2 or 3.
- **What is recorded** (`BrainSharing.signIn`): nothing for the machine's git, `{ kind: 'gh', user }` for a GitHub CLI
  account (its token is asked from `gh` when needed and kept ten minutes in memory, never on disk), `{ kind: 'token' }`
  for a typed token, which is kept encrypted with safeStorage per brain in `brain-repo-tokens.json`
  (`RepoTokenStore`) and removed at Stop sharing and Leave.
- **How git gets it**: an `http.https://<host>/<owner>/.extraHeader` (`Authorization: Basic` of
  `x-access-token:<token>`) through `GIT_CONFIG_*` in git's environment, as for Azure Repos; never on a command line.
  `main.ts` puts `repoBrainEnv` in front of the Azure DevOps provider, so every fetch and push of such a brain
  (`BrainSync`) signs in the same way.
- **The repo is checked before the sync**: Share opens the repo and checks it is empty before queueing a paid `/sync`.
- `gh` is found on the person's PATH as the agents are (`Platform.probeCommand('gh')`), so a packaged app finds a
  Homebrew `gh`.
- A token from `gh` only ever goes to the host it belongs to: accounts are listed per host, and the header is scoped
  to the repo's owner on that host.
- Telemetry: `brain.share` has the outcome `needsToken` (`docs/telemetry.md`).

## Verified

`npm run typecheck`, `npm run lint`, the touched tests (the search order and its refusals, the GitHub CLI's output,
the token store, a share as a GitHub CLI account and with a typed token, the dialog's token step). Against GitHub
itself, on this Mac: with git's own login switched off (`GIT_CONFIG_GLOBAL=/dev/null`, no system config) the real
`findSignIn` with the real `gh` opened a private repo as the GitHub CLI account, and answered `needsToken` for a repo
that does not exist; the header by hand opened the same repo with `credential.helper` empty.

## Known gaps

- Not run from the app, and not on Windows (`gh.exe` started by its path; a `gh` that is a `.cmd` shim is not
  started and counts as no GitHub CLI, so the token step follows).
- A mistyped address is "not found" too, so it ends in the token step; the text says to check the address.
- A typed token that expires shows as "Can't sign in to …" on the brain; the way to replace it is Stop sharing and
  share or join again. Deleting a brain leaves its encrypted token in the file.
- A brain shared with v1.132.0 keeps git as it is on the machine (it worked there, or it was never shared).
- GitLab and others get the same header (`x-access-token` as the user); only GitHub was tried.
