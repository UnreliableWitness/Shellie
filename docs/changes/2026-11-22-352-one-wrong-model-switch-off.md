# One wrong-model switch-off

Issue #352, branch `agent/issues/352-wrong-model-switch-off-is-written-twice`.

The rule "another model answered, so every project dreaming on that model goes off, each with a switch-off record and
its passed test forgotten" was written twice: in the scheduler (after a dream) and in the dream handlers (after a failed
re-test in setup). The two copies had drifted. It now lives in one scheduler method, `switchOffModel`, which runs in
the scheduler's serial chain, so it no longer interleaves with a check. A dream and the setup's re-test both use it.
The filter "projects on this model" is one shared `projectsOnModel` (`src/shared/dreams.ts`), also used by the legacy
switch-off adoption at start.

What users see stays the same, with two small differences after a re-test that another model answered:

- When the switch-off record cannot be written, dreaming now stays off until Shellie quits, as it already did after a
  dream.
- `dream.switched_off` (`by: wrong-model`) is sent once per re-test, no longer once per affected project. The event and
  its `by` values do not change, so `docs/telemetry.md` does not either.

Before the scheduler has started (the dream store is not loaded yet), a failed re-test still saves the projects off
without a record, as before; the event is then sent once as well.

## Not verified

The app was not run; Windows not tested locally. Covered by `scheduler.test.ts`, `dreamHandlers.test.ts` and
`dreams.test.ts`.
