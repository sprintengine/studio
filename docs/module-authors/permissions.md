# Module Permissions Reference

A capability module declares the access it needs in the `permissions` array of
its `manifest.json`. In the studio's v1 security model (ed25519 signing +
explicit user trust, in-process execution), permissions
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
| `filesystem:read-home` | Read your app configuration and home folder | Reads outside the workspace (home, userData) |
| `process:spawn` | Run external programs on your machine | Spawning child processes |
| `network` | Make network requests | Any outbound network access |
| `ipc:workspace-read` | See workspace, window, git, and task state through the app's APIs | See tier mapping below |
| `ipc:workspace-write` | Create and change workspaces, files, and tasks through the app's APIs | See tier mapping below |
| `ipc:settings` | Read and change app settings and integrations | See tier mapping below |
| `ipc:invoke` | Call any of the app's internal APIs, including its own background code (broad scope) | The entire `window.api` surface, **and** the renderer&rarr;module-main bridge |
| `backlog.read` | Read Backlog item details and source content | `listBacklogItems`, `watchBacklogItems` |
| `backlog.write` | Change Backlog item status, links, and metadata | Backlog status/link/metadata writes |
| `backlog.link.open` | Open links and targets attached to Backlog items | Opening a link provider's target |
| `scheduled-agents.manage` | Schedule agents of its own that start a chat on a timer | Creating, changing and running its own scheduled agents |
| `agents:companion` | Run its own background agents inside the workspace | The companion-agents service |
| `storage` | Save its own data in the workspace folder and app data | The module storage bags |
| `conversation:read` | Read the chats it started, including everything the agent says in them | `getConversationService`: `subscribe`, `transcript`, `list`, `watch` |
| `conversation:operate` | Start chats with agents, send them messages, and stop them | The whole conversation service, and `RendererHost.openChat`. Implies `conversation:read` |
| `secrets` | Store API keys and send them to the sites it names (the key is never shown back to the extension) | `getSecretsService` |
| `github` | Use your GitHub sign-in to call the GitHub API (the token is never shown to the extension) | `getGitHubService` |
| `mcp:tools` | Add tools that agents in your workspaces can call | `MainHost.registerMcpTools` |

## The `ipc:*` tiers

`ipc:invoke` predates the tiers and disclosed the whole internal API surface in
one opaque scope. It remains valid so existing manifests keep working, but the
consent UI flags it as broad. New modules should declare the tier(s) matching
the `window.api` areas they call:

- **`ipc:workspace-read`** — observing workspace and project state:
  workspace-sync snapshots and events, window state, git read models (status,
  branches, history, graph, worktree lists), Backlog reads,
  knowledge/memory reads, terminal
  session lists, workspace backup reads.
- **`ipc:workspace-write`** — changing workspace and project state through
  the studio: workspace-sync command dispatch, filesystem mutation routes, git
  mutations (stage/commit/push/branch/worktrees), Backlog mutations,
  workspace backup writes.
- **`ipc:settings`** — reading and changing the studio's settings and
  integrations: module enablement, third-party module install/trust, MCP
  servers and their sync, Skills, the plugin registry, GitHub token, app updates,
  voice transcription settings.

A few surfaces (window controls, native dialogs, clipboard, auth/session,
external-URL opening, and launching or driving agents and terminals) sit
outside every tier today; only the legacy
`ipc:invoke` scope discloses those. A module that wants an agent should not
reach for them: the conversation service and `openChat` are the supported way,
behind `conversation:read` / `conversation:operate`.

## Honesty rules

- Permissions are disclosure first, not a sandbox. Do not describe your module
  as "sandboxed" or "restricted to" its declared scopes — the app does not
  broker most API calls at runtime.
- These scopes are genuinely checked, and a module missing them is refused
  with `permission_missing` (or a throw, where a call has no failure shape):
  - `ipc:invoke` gates the renderer&rarr;module-main bridge (`MainHost`);
  - `agents:companion` is checked when a module attaches a companion agent;
  - `conversation:read` and `conversation:operate` are checked on every call to
    the conversation service, and `conversation:operate` on
    `RendererHost.openChat`. Both are scoped further, by owner: a module
    reaches only the chats it created, never another module's and never the
    user's own;
  - `secrets` and `github` are checked on every call to their brokers. Neither
    hands the credential to module code: a secret leaves the host only inside a
    request to an https origin it was stored with, and the GitHub token only
    inside a request to the GitHub API;
  - `mcp:tools` is checked when a third-party module registers gateway tools.
- A module reaches agents only as chats. There is no scope for launching or
  driving an agent terminal, because no module API does it.
- Declaring less than you use is a trust violation users can hold against your
  publisher key; signature verification binds your manifest (including
  `permissions`, and the `files` digests of your code) to the signed content, so
  changing declared access or shipped code requires re-signing and
  re-trusting.

## Example

```json
{
  "id": "acme-workspace-dashboard",
  "displayName": "Workspace Dashboard",
  "version": 1,
  "source": "third-party",
  "engines": { "hostApi": 1 },
  "permissions": ["ipc:workspace-read", "conversation:operate", "secrets"]
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
