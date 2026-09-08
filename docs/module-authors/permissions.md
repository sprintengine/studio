# Module Permissions Reference

A capability module declares the access it needs in the `permissions` array of
its `manifest.json`. In Multicode's v1 security model (ed25519 signing +
explicit user trust, in-process execution — the IDE-plugin model), permissions
are **install-time disclosure**: they are shown to the user before they trust
your module, and they describe what your module does. They are **not a runtime
sandbox** — a trusted module's code runs in the app's process with the app's
access. Declare what you actually touch so users can make an informed trust
decision.

The canonical vocabulary lives in `src/shared/modules/permissions.ts`
(`KNOWN_CAPABILITY_PERMISSIONS`). Unknown scopes do not fail validation
(forward-compatible), but the consent UI surfaces them verbatim as
"Unrecognized capability", which reads as a red flag to users — prefer the
known scopes.

## Vocabulary

| Scope | Consent description | Discloses |
| --- | --- | --- |
| `filesystem:read-workspace` | Read files in the open workspace | Direct reads of workspace files |
| `filesystem:write-workspace` | Create and modify files in the open workspace | Direct writes to workspace files |
| `filesystem:read-home` | Read your Multicode configuration and home folder | Reads outside the workspace (home, userData) |
| `process:spawn` | Run external programs on your machine | Spawning child processes |
| `network` | Make network requests | Any outbound network access |
| `ipc:workspace-read` | See workspace, window, git, and task state through Multicode APIs | See tier mapping below |
| `ipc:workspace-write` | Create and change workspaces, files, and tasks through Multicode APIs | See tier mapping below |
| `ipc:agents` | Launch and control agents and terminals | See tier mapping below |
| `ipc:settings` | Read and change Multicode settings and integrations | See tier mapping below |
| `ipc:invoke` | Call any of Multicode's internal APIs, including its own background code (broad scope) | The entire `window.api` surface, **and** the renderer&rarr;module-main bridge |
| `backlog.read` | Read Backlog item details and source content | `listBacklogItems`, `watchBacklogItems` |
| `backlog.write` | Change Backlog item status, links, and metadata | Backlog status/link/metadata writes |
| `backlog.link.open` | Open links and targets attached to Backlog items | Opening a link provider's target |
| `automations.manage` | Create and manage its own scheduled automations | Registering and running its own automations |
| `agents:companion` | Run its own background agents inside the workspace | The companion-agents service |
| `storage` | Save its own data in the workspace folder and app data | The module storage bags |

## The `ipc:*` tiers

`ipc:invoke` predates the tiers and disclosed the whole internal API surface in
one opaque scope. It remains valid so existing manifests keep working, but the
consent UI flags it as broad. New modules should declare the tier(s) matching
the `window.api` areas they call:

- **`ipc:workspace-read`** — observing workspace and project state:
  workspace-sync snapshots and events, window state, git read models (status,
  branches, history, graph, worktree lists), Backlog reads,
  Sprint Engine reads and projections, knowledge/memory reads, terminal
  session lists, workspace backup reads.
- **`ipc:workspace-write`** — changing workspace and project state through
  Multicode: workspace-sync command dispatch, filesystem mutation routes, git
  mutations (stage/commit/push/branch/worktrees), Backlog mutations,
  Sprint Engine task mutations, workspace backup writes.
- **`ipc:agents`** — launching and controlling agents and terminals: terminal
  spawn/write/kill and terminal event streams, conversation provider sessions,
  Sprint Engine runner and roster controls, soul prompts.
- **`ipc:settings`** — reading and changing Multicode settings and
  integrations: module enablement, third-party module install/trust, MCP
  catalog and sync, Skills, the plugin and role registries, GitHub
  token, app updates, mobile bridge settings, voice transcription settings.

A few surfaces (window controls, native dialogs, clipboard, auth/session,
external-URL opening) sit outside every tier today; only the legacy
`ipc:invoke` scope discloses those.

## Honesty rules

- Permissions are disclosure first, not a sandbox. Do not describe your module
  as "sandboxed" or "restricted to" its declared scopes — the app does not
  broker most API calls at runtime.
- Two scopes are genuinely checked, and a module missing them is refused with
  `permission_missing`: `ipc:invoke` gates the renderer&rarr;module-main bridge
  (`MainHost`), and `agents:companion` is checked when a module attaches a
  companion agent.
- Declaring less than you use is a trust violation users can hold against your
  publisher key; signature verification binds your manifest (including
  `permissions`) to the signed content, so changing declared access requires
  re-signing and re-trusting.

## Example

```json
{
  "id": "acme-workspace-dashboard",
  "displayName": "Workspace Dashboard",
  "version": 1,
  "permissions": ["ipc:workspace-read", "network"]
}
```

`id` is matched against `/^[a-z0-9][a-z0-9-]{0,62}$/` — lowercase alphanumerics
and hyphens only, no dots — and `version` is a required positive integer.
`permissions` may be omitted (it defaults to `[]`); when present it must be an
array of non-empty strings, and duplicates are deduped silently. The validator
is `validateCapabilityPermissions`, single-sourced from
`packages/module-sdk/src/manifest-validate.ts`, which is also where the
vocabulary an external author actually reads is duplicated
(`packages/module-sdk/src/index.ts`).
