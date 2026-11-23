# Week page reads through useLiveQuery

Issue #355, branch `agent/issues/355-week-page-rebuilds-uselivequery-by-hand`.

The Week page kept its own load state, a timer and a hand-written 5 s throttle on `time:changed` to read `time:week`.
That copy had no guard against late answers: clicking Previous week while the current week was still loading, or
changing week while a throttled refetch was in flight, could let the older week's answer land last and fill the table
under the new week's header. The page now reads through `useLiveQuery`, which ignores answers for a week it has left.
The refresh rate (at most every 5 s), the navigation and the table stay the same.

`useLiveQuery` reports only that a load failed, not why, so the error text is now a fixed "Could not load the week"
without the underlying message. No telemetry change.

`SprintScreen` has the same hand-written throttle; moving it to `useLiveQuery` is a separate change.

## Not verified

The app was not run; Windows not tested locally. Covered by `WeekScreen.test.tsx`.
