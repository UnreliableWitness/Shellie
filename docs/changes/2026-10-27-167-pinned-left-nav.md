# Left nav and page header stay put when a page scrolls (#167)

Branch: `agent/issues/167-left-nav-drawer-should-stay-pinned-when`

Scrolling down on Home moved the left nav and the page header off screen with the content. The cause: Home had no
scroll container. Most pages scroll inside `.page-body` (`flex: 1; min-height: 0; overflow: auto`), but Home renders
`.home-bands` without one, so tall content overflowed the shell and the whole document scrolled, nav included.

`.home-bands` (home.css) now has the same three rules, so Home scrolls inside the content area. Checking the other
screens that render `.page` without `.page-body` found the same gap on Secrets (`.secrets`) and Import from .env
(`.import`, both in secrets.css); they get the same fix. Settings, Setup, New task, Sprint, the done task page, Usage
and Docs already scroll in their own containers. `.app`, `.shell` and `.leftnav` are unchanged.

Tests: Vitest checks that those rules carry `overflow: auto` and `min-height: 0` (layout cannot run in jsdom).

Not verified: the behaviour in the running app, on macOS or Windows.
