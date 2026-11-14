# The brain list starts no git to count unsent changes

Issue #296, branch `agent/issues/296-brain-list-starts-two-git-processes-per`.

Since shared brains (#293), every `brain:list` counted the commits each shared brain had not sent yet: `rev-parse --verify origin/main` and `rev-list --count`, two git processes per shared brain. Several always-mounted hooks refetch the list on every `brain:changed`, which fires on each job status change and each BrainSync status patch, so a running job kept starting git in main. Spawns are slow on Windows (#271). Only the brain page shows the count, and it uses `brain:get`.

## What changed

- `view()` in `brainHandlers.ts` counts the unsent commits only when it works out health, which is `brain:get`. `brain:list` and `brain:forTask` leave `sharing.ahead` out instead of sending a false 0.
- The keeper is still looked up for every shared brain (settings' sharing controls need it; it reads two small files).
- The brain page is unchanged: it still shows the count of unsent changes.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New test: `brain:list` on a shared brain names the keeper, has no `ahead` and runs no `rev-list` or `rev-parse` (`brainHandlers.test.ts`); `brain:get` still returns the right count.

## Known gaps

- Not run in the app or on Windows.
