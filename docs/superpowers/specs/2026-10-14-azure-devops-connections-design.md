# MIAC sub-project 2: Azure DevOps connections and the work item picker

Date: 2026-10-14
Status: approved in conversation, awaiting written review
Builds on: `2026-10-14-task-workspace-design.md` (sub-project 1, merged in PR #1)

## Context

Sub-project 1 made a task a worktree plus terminals, created from a typed work item id and title. This slice connects MIAC to Azure DevOps so a task is created from a real work item. The owner has a test project at `https://dev.azure.com/unreliablewitness/MIAC`. MIAC must support more than one Azure DevOps organization, because the owner has a personal org and a client org, and a consultancy's customers may each host their own.

The UI reference is `design/mockups/NewTask.dc.html` (picker) and `design/mockups/Settings.dc.html` (Azure DevOps section).

## Scope of this slice

In:
- Connections in Settings: organization URL, project, personal access token; verify, remove; "Connected as" line and status.
- Each repo linked to one connection (or none).
- Work item picker in New task: Current sprint (default) or Assigned to me, free-text search by title or id, type badge, title, id, state, area path.
- Work item badge in the workspace header links to the work item in the browser.

Out:
- Changing work item state on create or finish.
- PR number and build status in the header.
- Customer mapping from area path, custom fields, comments (sub-projects 3 and 4).
- Azure CLI or MSAL sign-in (the owner's org rejects CLI-minted tokens; PAT is the only method for now).
- Any write to Azure DevOps.

## Decisions

- **Credentials**: PATs are encrypted with Electron `safeStorage` and stored in `connections.json` in the user data folder, separate from `state.json`. If `safeStorage.isAsyncEncryptionAvailable()` resolves false, saving a connection is refused with a notice; there is no plain-text fallback. The renderer sends the PAT once on save and never receives it back.
- **Client**: a small REST client over `fetch` with Basic auth (`:<pat>` base64) and `api-version=7.1`. No SDK.
- **Work item types** are read from the project, so Basic, Agile and Scrum processes all work. `WorkItemRef.type` becomes a plain string; the branch prefix stays `bugfix` for `Bug` and `feature` for anything else.
- **Picker default** is the current sprint for everyone, with an Assigned to me toggle. Results are capped at 50, ordered by changed date descending, closed and removed states excluded.
- **Repo without a connection** keeps the typed-id form from slice 1.

## Data model

```ts
type ConnectionStatus = 'unknown' | 'ok' | 'unauthorized' | 'unreachable';

type Connection = {
  id: string;
  name: string;              // defaults to the org slug, editable
  organizationUrl: string;   // https://dev.azure.com/<org>, no trailing slash
  project: string;
  user: string | null;       // display name from connectionData, for "Connected as"
  status: ConnectionStatus;
  checkedAt: string | null;
};

// connections.json (zod validated, atomic write)
type ConnectionsFile = {
  version: 1;
  connections: (Connection & { tokenCiphertext: string })[]; // base64 of safeStorage.encryptStringAsync(pat) (same format as the deprecated encryptString)
};

type WorkItemRef = { id: string; type: string; title: string; url: string | null };

type WorkItemSummary = {
  id: string; type: string; title: string; state: string;
  areaPath: string; iterationPath: string; assignedTo: string | null; url: string;
};
```

`Repo.connectionId` (already present, nullable) links a repo to a connection. Removing a connection sets `connectionId` to null on its repos.

## Services (main process, no Electron imports except where noted)

- `ConnectionStore(filePath, crypto)`: `list(): Connection[]`, `get(id)`, `save(input: { id?, name?, organizationUrl, project, pat }): Promise<Connection>`, `remove(id)`, `setStatus(id, status, user?)`, `token(id): Promise<string>`. `crypto` is an interface `{ available(): boolean; encrypt(s): Buffer; decrypt(b): string }`; `src/main.ts` passes an adapter over Electron `safeStorage`, tests pass a fake.
- `AdoClient(organizationUrl, token: () => Promise<string>, fetchImpl = fetch)`:
  - `verify(project): Promise<{ user: string }>`: `GET _apis/connectionData` then `GET _apis/projects/<project>`.
  - `currentIteration(project): Promise<{ path: string; name: string } | null>`: `GET <project>/_apis/work/teamsettings/iterations?$timeframe=current`.
  - `searchWorkItems(opts: { project; scope: 'sprint' | 'mine'; text: string; iterationPath: string | null }): Promise<WorkItemSummary[]>`: WIQL `POST <project>/_apis/wit/wiql` then batch `GET _apis/wit/workitems?ids=...&fields=System.Id,System.WorkItemType,System.Title,System.State,System.AreaPath,System.IterationPath,System.AssignedTo`. WIQL: `[System.TeamProject] = @project AND [System.State] NOT IN ('Closed','Removed','Done','Resolved')` plus `[System.IterationPath] = '<path>'` for `sprint` or `[System.AssignedTo] = @Me` for `mine`; a `text` that is all digits adds `OR [System.Id] = <n>`, otherwise `AND [System.Title] CONTAINS '<text>'`. Single quotes in `text` are doubled.
  - There is no work item types call: types come from search results and the typed form uses a fixed list, so no types call or cache is made.
  - Errors: `AdoError { kind: 'unauthorized' | 'not-found' | 'unreachable' | 'http'; status?: number; path: string }`. 401 and 203 (the sign-in page) map to `unauthorized`; 404 to `not-found`; network errors to `unreachable`; 429 retries once after `Retry-After` seconds (max 10).
- `AdoRegistry`: holds one `AdoClient` per connection id, invalidated on save/remove.

## IPC

Channels added to `src/shared/ipc.ts`:
- `connections:list` -> `Connection[]`
- `connections:save` (input with `pat`) -> `Connection` (verifies before saving; throws with the `AdoError` message on failure, nothing saved)
- `connections:remove` (id) -> void
- `connections:verify` (id) -> `Connection` (updates status and user)
- `repos:setConnection` (repoId, connectionId | null) -> `Repo`
- `workItems:currentIteration` (connectionId) -> `{ path; name } | null`
- `workItems:search` (connectionId, { scope, text }) -> `WorkItemSummary[]`
- `shell:openExternal` (url) -> void (only `https://dev.azure.com/` and `https://<org>.visualstudio.com/` URLs are allowed)

Events: `connections:changed` -> `Connection[]`. Any `unauthorized` error from a search or verify sets the connection status and broadcasts this event.

## Screens

**Settings, Azure DevOps section.** List of connections: name, organization URL, project, "Connected as <user>" (green) or the status reason (red), Verify and Remove buttons. "Add connection…" opens an inline form: organization URL, project, token (password field), Save. Save calls `connections:save`; on failure the form stays open with the message. The Repositories section gains a Connection dropdown per repo (`repos:setConnection`). Removing a connection that repos use asks for confirmation and unlinks them.

**New task, Work item mode.** If the selected repo has a connection, the left pane is the picker: search input, a segmented Current sprint / Assigned to me control (Current sprint default; falls back to Assigned to me with a hint when the project has no current iteration), and the result list with type badge, title, `id · state · area`. Selecting a row sets the work item (id, type, title, url) and the preview and branch prefill update exactly as with typed input. A third "Typed" tab keeps the slice-1 form for repos without a connection, and is auto-selected when there is none. Searches debounce 300 ms and ignore stale responses.

**Workspace.** The work item badge in the header becomes a link calling `shell:openExternal` with the stored url. The nav footer shows the selected task's connection name and a status dot (green `ok`, red otherwise, grey when the repo has no connection).

## Error handling

- Every `AdoClient` failure becomes a notice with the kind and path, never a silent empty list.
- A 401 on any call flips the connection to `unauthorized` and broadcasts `connections:changed`.
- `connections:save` with an unreachable org or wrong project fails before anything is written.
- A connection file that fails validation is backed up and ignored, as `state.json` is.
- Decrypt failure (for example after an OS keychain reset) marks the connection `unauthorized` with the message "Stored token could not be decrypted; enter it again".

## Testing

- `AdoClient` against a local `http` server fixture that serves recorded JSON for the four calls, plus 401, 404, 429 and malformed-body cases. No network in tests.
- `ConnectionStore` with a fake crypto; round trip, refusal when encryption is unavailable, removal unlinking repos.
- Handlers: save-verify-list with the fake server, repo linking, search mapping, status flip on 401.
- Renderer: connection form (save success and failure), picker (default search on open, toggle, selection fills the preview, typed tab when no connection).
- Live smoke over CDP against the owner's test org once the PAT is in the Keychain: add connection, link repo, search, create a task from a picked item.

## Open items for the owner

- A PAT for `unreliablewitness` stored in the macOS Keychain as `miac-ado-unreliablewitness` (account `miac`) for the live smoke. Scopes: Work Items (Read & Write), Code (Read).
