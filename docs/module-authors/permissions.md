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
| `module:bridge` | Let its window code talk to its own background code | The renderer&rarr;module-main bridge alone: `RendererHost.invoke` to the module's own `registerIpc` channels |
| `backlog.read` | Read Backlog item details and source content | `listBacklogItems`, `watchBacklogItems`, `getBacklogLocation`, and the reads of `getBacklogService` |
| `backlog.write` | Change Backlog item status, triage, links, and metadata, and create new items | The Backlog write API (`getBacklogService`, `createBacklogItem`, `updateBacklogStatus`, `updateBacklogTriage`, `addBacklogLink`, `updateBacklogModuleMetadata`) and the same writes in a Backlog action |
| `backlog.link.open` | Open links and targets attached to Backlog items | Opening a link provider's target |
| `scheduled-agents.manage` | Schedule agents of its own that start a chat on a timer | Creating, changing and running its own scheduled agents |
| `agents:companion` | Run its own background agents inside the workspace | The companion-agents service |
| `agents:generate` | Send prompts to your AI models in the background, without opening a chat | `getTextGenerationService`: one prompt answered by the person's own agent CLI (Claude Code or Codex), with no chat or workspace |
| `storage` | Save its own data in the workspace folder and app data | The module storage bags, module app state (read from main with `MainHost.getModuleAppState`), and the module's private data directory (`MainHost.getModuleDataDir`) |
| `conversation:read` | Read the chats it started, including everything the agent says in them | `getConversationService`: `subscribe`, `follow`, `transcript`, `reply`, `list`, `watch` |
| `conversation:operate` | Start chats with agents, send them messages, and stop them | The whole conversation service, `RendererHost.openChat` with `send: true`, and allowing a companion's tool call. Implies `conversation:read` |
| `conversation:bypass` | Let the agents in its chats edit files and run commands without asking you first | Running the module's chats on `bypass`, starting them with `allowedTools`, and a companion task with `tools: 'auto'`. Without it they run no looser than `auto` |
| `chat:draft` | Open a chat with a message drafted for you to read and send | `RendererHost.openChat` without `send`: the prompt waits in the composer for the person |
| `secrets` | Store API keys and send them to the sites it names (the key is never shown back to the extension) | `getSecretsService` |
| `github` | Use your GitHub sign-in to call the GitHub API (the token is never shown to the extension) | `getGitHubService`: REST requests, read-only GraphQL queries, and downloads that follow GitHub's own storage redirect |
| `mcp:tools` | Add tools that agents in your workspaces can call | `MainHost.registerMcpTools` |
| `usage:read` | See token usage and cost of every agent session on this machine | `getUsageService`, `RendererHost.queryUsage`: token counts of Studio chats and of the Claude Code and Codex sessions on the machine |
| `conversation:read-all` | Read every chat on this machine, including what you and the agents wrote (broad scope) | `getActivityService`: summaries of the person's Studio chats and the messages they sent, with the end of each reply |

## The `ipc:*` tiers

`ipc:invoke` predates the tiers and disclosed the whole internal API surface in
one opaque scope. It remains valid so existing manifests keep working, but the
consent UI flags it as broad. New modules should declare the tier(s) matching
the `window.api` areas they call, and `module:bridge` for the bridge to their
own `entry.main`:

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
  servers and their sync, Skills, the plugin registry, GitHub token, app updates.

A few surfaces (window controls, native dialogs, clipboard, auth/session,
external-URL opening, and launching or driving agents and terminals) sit
outside every tier today; only the legacy
`ipc:invoke` scope discloses those. The host's own narrow versions need no
permission: `MainHost.notify` (a bell row under the module's name),
`RendererHost.toast` (a transient report under the module's name), and
`RendererHost.openExternal` (an absolute http(s) URL, in the system browser,
through the app's own link path — nothing else). A module that wants an agent should not
reach for them: the conversation service and `openChat` are the supported way,
behind `conversation:read` / `conversation:operate` (and `chat:draft` for a
draft), with companions (`agents:companion`) and one-shot text generation
(`agents:generate`) beside them.

## Honesty rules

- Permissions are disclosure first, not a sandbox. Do not describe your module
  as "sandboxed" or "restricted to" its declared scopes — the app does not
  broker most API calls at runtime.
- These scopes are genuinely checked, and a module missing them is refused
  with `permission_missing` (or a throw, where a call has no failure shape):
  - `module:bridge` gates the renderer&rarr;module-main bridge (`MainHost`).
    The legacy `ipc:invoke` still opens it, so a manifest from before the
    split keeps working; a new module declares `module:bridge`, whose consent
    line says what the bridge is instead of "any of the app's internal APIs";
  - `agents:companion` is checked when a module attaches a companion agent.
    A companion's structured run denies every tool call its agent asks for
    unless the run says otherwise: `tools: 'auto'` needs `conversation:bypass`,
    and allowing one tool call with `respondToApproval` needs
    `conversation:operate`;
  - `agents:generate` is checked on every call to the text generation
    service, which also bounds each module to two calls at once, eight
    waiting, and thirty a minute;
  - `conversation:read` and `conversation:operate` are checked on every call to
    the conversation service, and `RendererHost.openChat` takes `chat:draft`
    or `conversation:operate` for a draft and `conversation:operate` for
    `send: true`. The service is scoped further, by owner: a module
    reaches only the chats it created, never another module's and never the
    user's own;
  - `conversation:bypass` is read on every `create` and `setPermissionPreset`.
    It sets the loosest preset the module's chats run on, `bypass` with it and
    `auto` without, and a looser request is lowered to that rather than
    refused. The one thing it refuses is `allowedTools` at `create`, which
    lets a chat use the named tools without asking and so needs the permission
    that lets it ask about nothing;
  - `secrets` and `github` are checked on every call to their brokers. Neither
    hands the credential to module code: a secret leaves the host only inside a
    request to an https origin it was stored with, and the GitHub token only
    inside a request to the GitHub API;
  - `mcp:tools` is checked when a third-party module registers gateway tools;
  - `backlog.read` and `backlog.write` are checked on every call to the
    Backlog service (`getBacklogService` and the renderer's Backlog write
    methods), and `backlog.read` on a third-party module's
    `listBacklogItems` / `watchBacklogItems`;
  - `usage:read` is checked on every call to the usage service;
  - `conversation:read-all` is checked on every call to the activity service.
    It is the one scope that reaches the person's own chats, read-only, and
    the consent prompt flags it as broad, as it does `ipc:invoke`.
  - `ipc:workspace-read` is checked on `getWorkspaceGitInfo` (both hosts); the
    rest of what it discloses stays disclosure-only.
- A module reaches agents only as chats, companions and one-shot prompts.
  There is no scope for launching or driving an agent terminal, because no
  module API does it.
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
