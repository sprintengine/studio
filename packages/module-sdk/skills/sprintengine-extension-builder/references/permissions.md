# Permissions

`permissions` in `module/manifest.json` — and the same list in `plugin.json` —
is what the person reads before trusting the module. The consent prompt shows
each as a sentence (below). Some are also checked by the host at the call; the
rest are disclosure: the host does not sandbox module code, so declaring
honestly is the author's side of the bargain.

Rules:

- Declare what the code does, no more. "Might need it later" is not a reason.
- Keep `plugin.json` identical: an install refuses a module that declares more
  than its bundle disclosed.
- Changing permissions changes the manifest, so trust is asked for again, and
  an update from GitHub or the marketplace asks again when they grow.
- An unknown string is allowed but shown as "Unrecognized capability" — a
  typo reads as something suspicious.

| Permission | The prompt says | Declare it when you use | Checked at the call |
| --- | --- | --- | --- |
| `storage` | Save its own data in the workspace folder and app data | `getModuleStorage`, module app state, workspace module state | — |
| `ipc:invoke` | Call any of the app's internal APIs, including its own background code (broad scope) | `host.invoke` from the renderer to your own `registerIpc` channels | yes (bridge) |
| `ipc:workspace-read` | See workspace, window, git, and task state through the app's APIs | `getWorkspace`, `listWorkspaces`, `watchWorkspaces`, `getWorkingRoot`, `WorkspaceContextToken` | — |
| `ipc:workspace-write` | Create and change workspaces, files, and tasks through the app's APIs | `WorkspaceServiceToken.create` | — |
| `ipc:settings` | Read and change app settings and integrations | — (legacy scope) | — |
| `filesystem:read-workspace` | Read files in the open workspace | `watchWorkspaceFile`; Node reads under a workspace root in `entry.main` | — |
| `filesystem:write-workspace` | Create and modify files in the open workspace | Node writes under a workspace root in `entry.main` | — |
| `filesystem:read-home` | Read your app configuration and home folder | Reading outside workspaces. Almost never right — use storage | — |
| `process:spawn` | Run external programs on your machine | `child_process` in `entry.main` | — |
| `network` | Make network requests | `fetch`/sockets from `entry.main` or the renderer (not needed for the brokers) | — |
| `backlog.read` | Read Backlog item details and source content | `listBacklogItems`, `watchBacklogItems` | — |
| `backlog.write` | Change Backlog item status, links, and metadata | `updateStatus`, `addLink`, `updateModuleMetadata` in a Backlog action | — |
| `backlog.link.open` | Open links and targets attached to Backlog items | A link provider's `openLink` | — |
| `scheduled-agents.manage` | Schedule agents of its own that start a chat on a timer | `getScheduledAgentsService` | — |
| `agents:companion` | Run its own background agents inside the workspace | `getCompanionAgentsService` | yes |
| `agents:generate` | Send prompts to your AI models in the background, without opening a chat | `getTextGenerationService` | yes |
| `conversation:read` | Read the chats it started, including everything the agent says in them | `subscribe`, `follow`, `transcript`, `reply`, `list`, `watch` | yes |
| `conversation:operate` | Start chats with agents, send them messages, and stop them | `openChat` with `send: true`, every conversation-service call (implies read), allowing a companion's tool call | yes |
| `conversation:bypass` | Let the agents in its chats edit files and run commands without asking you first | `bypass` chats, `allowedTools`, a companion task with `tools: 'auto'` | yes |
| `chat:draft` | Open a chat with a message drafted for you to read and send | `openChat` without `send` | yes |
| `secrets` | Store API keys and send them to the sites it names (the key is never shown back to the extension) | `getSecretsService` | yes |
| `github` | Use your GitHub sign-in to call the GitHub API (the token is never shown to the extension) | `getGitHubService` | yes |
| `mcp:tools` | Add tools that agents in your workspaces can call | `registerMcpTools` | yes |

Registering commands, panels, workspace types, doors, top-bar items, settings
sections, Backlog and Files actions and skills needs no
permission: what they can then do is what the permissions above cover.

`dependsOn` is not a permission but is checked: a module that uses
`getScheduledAgentsService` lists `"scheduled-agents"`; one that calls `getConversationService`, `getModuleStorage` or
`getCompanionAgentsService` at the top of `registerMain` lists
`"agent-runtime"`, so the provider registers first.

The smoke test (`test/smoke.test.mjs`) fails when a service reached during
registration is missing its permission or dependency, and when a renderer
module registers IPC channels without `ipc:invoke`.
