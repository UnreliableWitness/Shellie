# "Process ended" over a session that runs (#288)

Branch `agent/issues/288-process-ended-resume-session`.

A Claude Code tab could show the bar "Process ended · Resume session · Close" under a session that worked fine.

A cause that is proven in a test: after an app relaunch, a mounted terminal view asks main for its buffer and whether
it runs. Main no longer knows the terminal, so the view marks it gone and an autoStart tab (Claude Code, shell) is
restarted with `--resume` right away. The "is it running?" question went out before the restart, and its answer
(`false`) arrived after it, so the view set exit code -1 ("Process ended") over the resumed session. The view now
counts the processes it started (restart, `terminal:reset`) and drops an answer about an earlier one.

Also:

- On a `terminal:exit` event the view asks main whether the terminal runs again before it shows the bar, so a late
  or stale exit never covers a live process.
- Main keeps each terminal's real exit code (`TerminalManager.exitCode`, `terminals:exitCode`); a view mounted after
  the exit shows "Exited with code N" instead of an invented "Process ended".
- Every exit is logged as `[terminals] <id> ended (code <n|unknown>, host lost: <bool>)`; `host lost: true` means the
  pty host utility process went away.

The bar still shows for real exits. No telemetry events change.

Not verified: the reporter runs Windows; whether their bar came from this relaunch race or from another false exit
signal (ConPTY, a lost pty host) is not proven. If it happens again, the `[terminals] ... ended` log line tells which.
The app was not run; the change is covered by Vitest only.
