# Finish names the missing branch when a PR cannot be opened

Issue #342, branch `agent/issues/342-finish-fails-to-open-a-pr-azure-devops-s`.

Finish with "create pull request" failed with Azure DevOps's raw "TF401398: … the source and/or the target
branch no longer exists" (HTTP 400). The message did not say which branch or what to do. The target comes from
the task's `baseRef`, which is stored when the task starts and never checked again. A base branch deleted or
renamed on origin since then is the likely cause.

`openPullRequest` (`src/main/ipc/handlers.ts`) now asks origin first, through the new
`GitClient.remoteBranchExists` (`git ls-remote --heads`, run without a console like `push`, with the fetch
timeout). This happens only when no active PR exists yet. When the target is gone, Finish stops before the POST
with "Pull request not created: target branch X no longer exists on origin; pick another base branch". When
ls-remote itself fails (offline, no sign-in), the check is skipped and the POST decides. When Azure DevOps
still returns that 400, both branches are checked again. The error then names the missing target or source, or
both branch names when origin has both. The task goes back to ready as before. Since the error now names the
target, a target other than `main`, `master`, `develop`, `dev` or `trunk` is added to the values telemetry
scrubs (task branches already were).

`pr.failed` now also carries `status` and `code` (the `TF…` number) for Azure DevOps errors, in both the
single-repo and the multi-workspace Finish, so the two causes can be told apart (`docs/telemetry.md`).

Tests: `handlers.part4.test.ts` (target deleted on the bare origin: refused before `createPullRequest`; a 400
from the fake with the target gone: named, `pr.failed` with status 400 and TF401398; a 400 with both branches
present: both named).

Known gap: there is no in-app picker for another target branch, and Shellie does not retarget to the default
branch on its own. Not verified: the running app, a real Azure DevOps remote (the ls-remote sign-in path), and
Windows (tested through Vitest on macOS only).
