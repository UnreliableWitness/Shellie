# Brain wiki mirror allows long paths on Windows

Issue #321, branch `agent/issues/321-brain-read-doesn-t-work-during-task-setu`.

Starting a task with a brain linked to an Azure DevOps wiki could warn
`brain not refreshed: git ... reset -q --hard origin/wikiMaster failed (128): ... Filename too long`.
The wiki mirror (`<brain>/.mirror`) is a git checkout, and deep wiki pages with long names go past the
Windows 260-character path limit, which git refuses unless `core.longpaths` is on.

Every git call on the mirror (`src/main/brain/mirror.ts`, clone, fetch, reset, sparse-checkout, checkout)
now passes `-c core.longpaths=true` next to `-c core.autocrlf=false`, like the worktree commands in
`GitClient` already do. The setting is passed per command, so existing mirrors need no action; the next
refresh works. Harmless on macOS and Linux.

Test: `mirror.test.ts` checks that the mirror's git calls on the first refresh (clone) and the next one
(fetch and reset) all carry both settings.

Not verified: a real path over 260 characters on Windows (the CI cannot reproduce it there in a test);
the fix relies on git for Windows honouring `core.longpaths`, as it does for worktrees.
