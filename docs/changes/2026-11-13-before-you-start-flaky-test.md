# Flaky BeforeYouStart test on Windows

`main`'s CI failed after #286 (a docs-only merge) on `test (windows-latest, part 2/3)`.
`BeforeYouStart > names the unread long read …` expected the `reading.nudge` event right after the row appeared, but
the component tracks it in a passive `useEffect`. The row shows after an async `brain:forTask` answer, and React can
run that effect after `findByRole` has resolved. The test now waits for the event with `waitFor`. The component is
unchanged.

Verified: the test file passed 20 runs in a row on macOS, and typecheck and lint pass. The Windows timing could not
be reproduced locally; this PR's CI is the check there.
