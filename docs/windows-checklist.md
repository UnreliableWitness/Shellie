# Manual Windows checklist

Download the installer from GitHub: open the Actions run for the commit, then the `Shellie-Setup-<sha>` artifact. For a `v*` tag, use the Release instead.

1. Download `Shellie-Setup.exe` from the CI run or release and run it. Note whether SmartScreen warns (expected while unsigned) and whether the publisher shows (signed).
2. **Settings:**
   - add a git repo;
   - add an Azure DevOps connection;
   - check that the receiver shows "Listening on 127.0.0.1:4319".
3. **Create a task** from a work item, with a setup command (for example `npm ci`). Check:
   - the setup log streams;
   - the worktree appears next to the repo as `<repo>.worktrees\<slug>`;
   - `npm ci` warnings (stderr) do not fail the step, on PowerShell 7 and on Windows PowerShell 5.1;
   - a setup command that uses `&&` needs PowerShell 7 (`pwsh`); Windows PowerShell 5.1 rejects it, so use `;` or install PowerShell 7.
4. **Terminals.** The PowerShell tab opens. Claude Code starts with the task prompt. Copilot CLI starts, if it is installed.
   - Title quotes are intact only for a native `claude.exe`. For an npm-installed claude (a `.cmd` shim), `"` becomes `'` and `& | < > ^ %` are dropped from the prompt; that is expected.
5. **Usage.** Ask Claude something. Within about 10 s the cost tile and the Usage screen show the usage.
6. **Open in VS Code.** It opens the worktree, with no stray console window.
7. **Finish** with all boxes ticked. Check that:
   - the worktree folder and branch are removed;
   - the work item has the fields and the comment.
8. **Restart the app.** State, connections and usage are kept. Starting Shellie a second time while it runs focuses the open window instead of opening another.
9. **Splash and icon.** Start the app. Check that:
   - the splash appears centred, plays, shows the boot steps and hands off to the main window;
   - a click or a key press skips it;
   - with Settings > Appearance > "Show splash on start" off, the next start has no splash;
   - the taskbar icon is legible at 100% and 150% display scaling;
   - the 16 px title-bar icon is sharp, not blank or blurry;
   - the installer (`Shellie-Setup.exe`) and the Start menu entry show the Mind dial icon;
   - Settings > Apps > Installed apps (Apps & features) shows the Mind dial icon for Shellie, not the Electron icon. The installer fetches it from `main` on GitHub, so this needs a build after the merge;
   - the main window has no menu bar above the task strip.
10. **Shortcuts.** While a PowerShell terminal has focus, `Ctrl+0` opens the Usage tab, `Ctrl+1..9` switch terminals and `Ctrl+Shift+F` toggles Focus. `Ctrl+C` still interrupts the running command.
    - On a Belgian or French (AZERTY) keyboard, `Ctrl+1` (the `&` key, no Shift) switches to the first terminal and `Ctrl+0` (the `à` key) opens the Usage tab.
11. **Auto-update.** Needs two tag releases, vN and vN+1 (for example `v0.2.0` and `v0.2.1`), each a normal release with `Shellie-Setup.exe`, `RELEASES` and `shellie-<version>-full.nupkg` attached.
    - Install vN from its release and start it. Settings shows version N.
    - Publish vN+1. Within about an hour (or restart Shellie and wait 30 s), a notice says the new version is downloaded and a dialog offers Restart now or Later.
    - Pick Later, quit Shellie and start it again from the Start menu: Settings shows version N+1.
    - Repeat with vN+2 and pick Restart now: Shellie closes, restarts and shows version N+2. Open terminals are closed by the restart.
    - The first start after an install (Squirrel's `--squirrel-firstrun`) does not check; the 10-minute check still does.
    - With `"autoUpdate": false` in `%APPDATA%\Shellie\settings.json`, no update is downloaded.
    - `https://update.electronjs.org/UnreliableWitness/Shellie/win32-x64/<N>/RELEASES` returns a line naming the vN+1 `.nupkg`.

12. **Terminal rendering.** In a task's PowerShell tab and its Claude Code tab, check that:
    - Claude Code's start-up logo (the block-character mascot) and its rounded input box are drawn cleanly, with no gaps, overlaps or stretched characters.
    - In PowerShell, type a command longer than the window width, then resize the window narrower and wider: the line wraps and unwraps without duplicated or scrambled text. `cls`, `Get-ChildItem` and PSReadLine's grey prediction text look as they do in Windows Terminal.
    - Resizing while Claude Code runs redraws it without leftover fragments.

13. **Work item and pull request.** Use a repo whose `origin` is an Azure Repos URL in the connection's organization, with a PAT that has Work Items (Read & write) and Code (Read & write).
    - Start a task on a work item in To Do. The setup step "Update work item" ends with a check, and in Azure DevOps the item shows Doing (or the type's In Progress state) and is assigned to you.
    - Commit a change in the task. On the Finish page, tick "Create a draft pull request into <base>" and finish. A draft pull request opens in the browser, from the task branch into the base, with the work item linked and the commit listed in its description.
    - On the Done page, the Pull request fact shows `PR <id> · Draft` and the branch shows as pushed.
    - Remove the cached Azure DevOps credential (Credential Manager, Windows Credentials, `git:https://dev.azure.com`) and finish another task with the box ticked. The Git Credential Manager sign-in appears (check behind Shellie too); after signing in the PR is created. If you ignore it, Finish stops after 120 s with "git push timed out after 120 s (a credential prompt may be waiting)" and the task stays ready.


14. **Docs tab, terminal links and Send to.**
    - Open a task and press `Ctrl+Shift+D`: the Docs tab opens.
    - `.shellie\task.md` renders.
    - Ask Claude to write `docs\x.md`: the tab shows "Updated" and reloads.
    - Click a printed `src\a.ts:3` link in a terminal: VS Code opens at line 3.
    - Select text in the Docs tab and use Send to Claude, then Send to PowerShell. PowerShell 7 gets a multi-line paste; Windows PowerShell 5.1 without PSReadLine gets one line (`path:N-M "text"`). Enter is never sent.
    - Finish the task with the Docs tab open: the worktree is removed with no "in use" error.

15. **Changes page and Visual Studio.**
    - With Visual Studio installed, Settings > Editor lists it; a repo with a `.sln` opens that solution from the task row's Open in Visual Studio, from the worktree (not the main checkout).
    - With two solutions, the menu lists both and the pick is remembered for the repo.
    - Open file in editor on the Changes page opens the file in the running Visual Studio at the cursor line (`/command "Edit.GoTo <line>"`). If it opens at the top, record it as a known gap.
    - The Changes tab shows a diff (Monaco loads in the packaged build, no CSP errors in the DevTools console).
    - A commit made in the task's shell refreshes the Changes tab within a second.
    - Finish with the Changes tab open: the worktree is removed with no in-use error.

16. **Upgrade from MIAC.**
    - Install the last MIAC release, add a connection and a task, then quit MIAC.
    - Install `Shellie-Setup.exe` and start Shellie.
    - The task is listed.
    - The connection works without entering the PAT again.
    - `%APPDATA%\Shellie\migrated-from-miac.json` exists.
    - Uninstall MIAC from Apps & features.

If a setup command or a shim fails with "running scripts is disabled on this system": Shellie passes `-ExecutionPolicy Bypass`, but an execution policy set by Group Policy overrides it. Ask IT, or install claude and copilot as native `.exe` builds.

17. **Claude budget.** Home band shows Claude Code usage from `%USERPROFILE%\.claude\projects` and OpenCode from `%USERPROFILE%\.local\share\opencode\opencode.db`.

18. **`shellie run` arguments.** In a task whose repo has a stored secret and a `run:` entry that points at a `.cmd` or `.bat` file:
    - Ask Claude to run `shellie run <name> -- --flag value`: the agent tab gets the output and the exit code.
    - Ask for `shellie run <name> -- "a&b"` and `-- %DB%`: both are refused with "On Windows an argument for shellie run cannot hold …", exit 2, and nothing runs (no `agent · <name>` tab output).
    - `shellie run test -- --watch=false` in an npm repo passes `--watch=false` to the test script (npm gets `-- --watch=false`).

19. **`shellie` shim arguments (`shellie.cmd` → `powershell.exe -File shellie.ps1 %*`).** In an agent tab of a task with a stored secret and a `run:` entry `list: Write-Output` (prints each argument on its own line):
    - `shellie run list -- --flag -x value`: prints `--flag`, `-x`, `value` in that order. PowerShell must neither eat the `--` (the shim drops only the first one) nor bind `-x` as a parameter of `shellie.ps1`.
    - `shellie run list -x`: `-x` reaches the command (no `--` needed).
    - `shellie run list -- --` : the second `--` reaches the command.
    - From a `cmd.exe` prompt with the tab's `SHELLIE_RUN_*` variables set, `shellie run list -- "a b" c`: `%*` keeps the quoting, so `a b` and `c` arrive as two arguments.
    - `shellie` alone prints the usage and exits 2; `shellie run` with no name lists the commands.
