# Main-process API (`entry.main`)

`export const registerMain: RegisterMain = (host) => { … }` runs once, in
Studio's main process (Node, no window), after the module is trusted and
enabled. It may be async; Studio waits up to 10 seconds. Only use a main entry
when the idea needs Node, a service only main has, or work with no window
open — a renderer-only module is simpler, installs without a restart, and
asks for less trust.

Bundle it as one CommonJS file with `electron` external and everything else
bundled: the installed module has no `node_modules`. A new or rebuilt main
entry loads only after a Studio restart.

## The host

| Member | Notes |
| --- | --- |
| `moduleId`, `hostApiVersion`, `supports(capability)` | Identity; ask `supports` before using a newer capability. |
| `registerIpc(channel, handler)` | A channel the renderer calls with `host.invoke`. Must start with `<moduleId>:`; the module must declare `ipc:invoke`. Handler: `(event, payload) => result`; `event` is opaque. Validate `payload` — it is input. |
| `emit(topic, payload?)` | Push a signal to your renderer's `host.subscribe(topic, cb)` in every window. No replay. |
| `registerMcpTools(tools)` | Tools on the Studio MCP gateway every agent is connected to. Needs `mcp:tools`. |
| `registerSkills(skills)` / `ensureSkillInstalled(root, id)` | Ship skills (folders with SKILL.md) inside the module and put them in a workspace. |
| `notify({ severity, title, body? })` | A bell notification, stamped with the module's identity. Bounded per module. |
| `onStartup(hook)` / `onShutdownBegin(hook)` / `onShutdown(hook)` | Start watchers on startup; stop loops at shutdown begin; release everything at shutdown. |
| `requireService(token)` / `getService(token)` | Host services by token (below). `requireService` throws when absent. |
| `provideService(token, factory)` | Offer a service to modules that depend on yours. |
| `registerSidecar(spec)` | A declaration only; the host does not spawn third-party sidecars. |

## Services

Each helper closes over `host.moduleId`, so a module only ever reaches its own
data. Call a helper at the top of `registerMain` only when the manifest's
`dependsOn` guarantees the provider loaded first; otherwise call it inside the
handler that needs it.

| Helper / token | Permission | `dependsOn` | What |
| --- | --- | --- | --- |
| `getConversationService(host)` | `conversation:read` / `conversation:operate` | `agent-runtime` | The module's own chats — [conversation-api.md](conversation-api.md) |
| `getModuleStorage(host)` | `storage` | `agent-runtime` | JSON key-value store, per workspace (`workspaceRoot`) or global; 1 MB per value; atomic writes |
| `getSecretsService(host)` | `secrets` | — | API keys the host holds and sends only to named origins — [brokers.md](brokers.md) |
| `getGitHubService(host)` | `github` | — | GitHub API calls with the user's sign-in — [brokers.md](brokers.md) |
| `getScheduledAgentsService(host)` | `scheduled-agents.manage` | `scheduled-agents` | Create/list/update/remove/run the module's own scheduled agents, and hear when they change |
| `getCompanionAgentsService(host)` | `agents:companion` | `agent-runtime` | A workspace-bound background agent with a structured `runStructured` task API |
| `host.requireService(WorkspaceContextToken)` | `ipc:workspace-read` | — (resolve in handlers) | `get(id)` / `list()` of open workspaces: `{ id, name, folderPath, mode }` |
| `host.requireService(WorkspaceServiceToken)` | `ipc:workspace-write` | — (resolve in handlers) | `create({ name, folderPath })` a workspace |
| `getBacklogService(host)` | `backlog.read` / `backlog.write` | `agent-runtime` | List, locate, create and change Backlog items through the app — below |
| `getUsageService(host)` | `usage:read` | `agent-runtime` | Token usage of every agent session on the machine — below |
| `getActivityService(host)` | `conversation:read-all` | `agent-runtime` | The person's Studio chats and prompts, read-only — below |

## MCP tools

```ts
host.registerMcpTools([
  {
    name: `${host.moduleId.replace(/-/g, '_')}_word_count`,
    description: 'Count the words in a piece of text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    mutates: false,
    handler: async (args) => ({ content: [{ type: 'text', text: String(String(args.text).split(/\s+/).length) }] }),
  },
])
```

- Names are a public contract: prefix with the module id, keep them stable.
- A third-party tool counts as changing state unless it declares
  `mutates: false`. Declare it on every read-only tool.
- `args` comes from an agent: validate every field; return `isError: true`
  with a sentence the agent can act on rather than throwing.
- While the module is disabled its tools stay listed and answer with an
  "enable the module" error.

## Scheduled agents

A scheduled agent is a prompt and a cron schedule: each time the schedule
comes round, a new chat starts in `folderPath` with the prompt as its first
message, on the CLI, model, permissions, skills, MCP servers and worktree
setting recorded. `getScheduledAgentsService(host).create(draft)` validates
the draft (a cron that does not parse, or never comes round, is refused with
the reason) and answers `{ ok: true, agent }` with `agent.nextRunAt`. The
module sees and changes only the ones it created; the person sees them in the
sidebar with their own, and can close them.

## Backlog, usage and activity

**Backlog.** `getBacklogService(host)`: `list`, `getLocation`, `create`,
`updateStatus`, `updateTriage`, `addLink`, `updateModuleMetadata`. `itemId` is
a `BacklogItemView.id`. Writes go through the app's Backlog service in the
project's mutation lane; `create` uses the app's create path and answers
`{ id, relativePath, path, numericId, displayId }`. Never write an item's file
yourself, and never derive the Backlog root: `getLocation` answers it.

**Usage.** `getUsageService(host).query({ from, to, groupBy })` sums tokens
(`input`, `output`, `cacheRead`, `cacheWrite`) and requests over Studio chats
and terminal Claude Code / Codex sessions, each request once. `groupBy`:
`day`, `model`, `provider`, `workspace`, `session`. Tokens only — price them
yourself. The first query waits for the first read of the logs; `onChanged`
says when to query again. Do not read `~/.claude` or `~/.codex` yourself.

**Activity.** `getActivityService(host)`: `listChats({ from?, to?,
workspaceId? })` and `prompts({ from, to, workspaceId?, limit? })` — the
person's messages with the tail of each reply, never tool output. Open
workspaces only. `conversation:read-all` is flagged broad in the consent
prompt; ask for it only when reading the person's chats is the module's point.

## Storage

```ts
const storage = getModuleStorage(host)
const saved = await storage.get({ key: 'state', workspaceRoot })   // { ok, value, found } | { ok: false, code, message }
await storage.set({ key: 'state', value: { count: 1 }, workspaceRoot })
```

Keys match `^[a-z0-9][a-z0-9._-]{0,63}$`. Omit `workspaceRoot` for the
module's global store. The host decides where files go (the workspace's
`.sprintengine/modules/<id>/`, or app data); never write your own files in
the home folder or the workspace for module state.
