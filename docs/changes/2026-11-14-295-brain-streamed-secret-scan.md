# Shared brains: the secrets scan streams git's output

Issue #295, branch `agent/issues/295-brain-push-secrets-scan-rebuilds-leaksca`.

## What changed

The secrets gate of a shared brain (`brain/share/secretScan.ts`) had its own copy of git's path unquoting and its own added-lines parser, and about 200 lines of chunking (blob sizes, path groups, a scratch `checkout-index` for large files) to keep every git output under GitClient's 16 MB buffer. Before each push it started at least four git processes per unsent commit.

Now:

- `secrets/leakScan.ts` has one streamed scan, `diffStreamHits`: it spawns git, reads the diff line by line through `DiffReader`, hands each file's added text to a `match` function (a big file in 4 MB pieces with a kept tail, as before) and stops at the first hit, or lists every file with one. `branchLeaks` (the Finish push check) is built on it, with the same result, 60 s timeout and errors.
- Before a push, `unsentSecretFile` runs one `git log -p --reverse --no-merges --no-renames -U0 --format=%x01%H <range>`. The `\x01<sha>` line before each commit's diff tells which commit a line belongs to, so commits already found clean are skipped and new clean ones are remembered (BrainSync's `scannedClean`). No diff line can start with `\x01`.
- At share time, `treeSecretFiles` runs one `git diff --no-renames -U0 <empty tree> <commit>` through the same reader and lists every file with a hit.
- `unquoteGitPath`, `secretsInDiff`, the chunking, `CHUNK_BYTES` and the `scanChunkBytes` deps are gone. BrainSync takes an optional `scanUnsent` dep instead, for tests.
- `DiffReader` now drops the tab git puts after a `---`/`+++` name that holds a space. It used to return `a b.md<tab>` for such a file, which also affected the file names on the Changes flag.

What users see stays the same: a push is held with the same file name, and a scan that cannot run (git fails or cannot start) still holds it as unchecked.

One difference: a file over the old chunk size used to be scanned whole, from the commit; now only its added lines are. For a new file that is the same text; for an edit it scans only what the commit adds, which is what is sent as new.

## Not verified

- Not run in the app. Windows (spawning git, the quoted-name cases skipped there) is only checked by CI.
- The brain scans have no timeout, as before (GitClient ran them without one); a hung git still blocks that brain's push.
