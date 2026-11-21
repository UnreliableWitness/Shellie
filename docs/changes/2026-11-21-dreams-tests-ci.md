# Dreams tests pass on CI again

`main` went red with the Dreams merge (#344): four tests in `src/main/dreams/` passed on the developer's Mac and failed
on the CI runners. Only tests change; a red `main` blocks releases.

- `DreamRunner.test.ts`, "bases the dream on the fetched target when origin is ahead" (macOS and Windows): the runners'
  git has no `init.defaultBranch`, so the bare origin's HEAD names `master`, the clone checks nothing out and
  `git push origin main` has no `main`. The test now checks out `main` in the clone.
- `dreamGit.test.ts` and `dreamHandlers.test.ts` (`dream:folderExists`), Windows: both wrote a file named `*.md` to
  prove paths are taken literally, and Windows allows no star in a file name. They now use `[x].md` (and
  `[A]GENTS.md`), which is a pattern to git and a legal name everywhere.
- `dreamHandlers.test.ts` (`dream:test`), Windows: the temp folder has a short (`RUNNER~1`) and a long spelling, so the
  relative path from the dreams folder to the run's folder climbed out. Both are now resolved with
  `realpathSync.native` while the folder exists.

## Verified

`npx vitest run src/main/dreams` passes locally, also with `init.defaultBranch=master` forced through
`GIT_CONFIG_*`. The Windows fixes were not run locally: this PR's CI is the check.
