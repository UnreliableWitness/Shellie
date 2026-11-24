# The setup copy step says what it copied and how long it took

Issue #369, branch `agent/issues/369-setup-copy-step-takes-about-10-s-at-the`.

Telemetry showed the 'Copy local files' setup step at a median of 10 s over a few runs on 1.116, against 214 ms
before, but nothing said which `copy` entry was slow or how big it was. The setup log only said `copied <rel>`.

- `copyFiles` (`src/main/services/SetupRunner.ts`) times each entry (the copy and leaving stored secrets out of it)
  and then counts the files and bytes it copied (`treeSize`: `lstat`, symlinks counted and never followed). The log
  line is now `copied <rel> (3 files, 60 B, 12 ms)`.
- The copy step's `done` event carries the totals (`copied: { files, bytes }`, agent config files not counted), and
  `handlers.ts` sends them as the metrics `setup.copy.files` and `setup.copy.bytes` (see `docs/telemetry.md`).

What is copied and how is unchanged. Skipping build-output folders, copying in parallel or warning on a large entry is
a follow-up once the numbers show which entries are slow. The jump on 1.116 is not explained by any code change.

## Not verified

Counting walks the copied tree once more after the copy; for a very large entry (a `node_modules` in `copy`) that adds
to the step's time, though not to the per-entry `ms` in the log. Not run on Windows; CI covers it.
