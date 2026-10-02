# Phase 5 — client tools: scoping spec

Status: scoped, 2026-10-02. Nothing here is implemented. This file replaces
the earlier phase 5 spec, "headless rendering", which planned a browser and a
canvas renderer inside the server. The owner ruling of 2026-10-02 withdrew
that plan, and this spec implements the ruling against the code as it stands
after phases 1–4. Section 13 lists what it changes in
`docs/design/studio-server.md` and the phase 6–9 specs; those changes are made
in the same change as this spec. Its open decisions (section 16) are rows
R80–R86 of `decisions.md`.

## 1. Summary

### 1.1 The ruling

| Ruling | Text |
| --- | --- |
| A small server (owner ruling 2026-10-02) | The server holds agents, conversations, tool routing between agents and clients, pairing and permissions, and raw access to its machine: read, list, search, watch and write files, run git, diffs, workspaces. It has no browser and no canvas. Things on a screen are client things. The browser and the canvas become tools that clients supply. |

It replaces ruling (e) of the parent ("the server has a headless mode for
anything that needs rendering") and goal 6 ("agents can draw, screenshot and
browse with no window open"). In v1, an agent working while no client is
attached has no browser and no canvas tools. A separate headless client can
bring them back later (section 14).

### 1.2 What this phase builds

1. **Client toolsets.** Any attached client can offer the server one or more
   toolsets: a name, and for each tool a name, a description and a JSON Schema
   for its input. The server lists those tools to agents through the Studio MCP
   gateway they already connect to. When an agent calls one, the server sends
   the call to the client that offered it and hands the client's answer back to
   the agent. This is a public SDK feature. A third-party app (a game offering
   `spawn_enemy`) uses the same mechanism the desktop uses.
2. **The desktop's `browser` toolset.** Today's 17 `browser.*` tools, with the
   same names, schemas and behaviour. They still run in the desktop's main
   process against the pane's `<webview>` through `browser-control.ts`. Only the
   way a call reaches them changes.
3. **The desktop's `canvas` toolset.** Today's eight `canvas.*` tools. The
   canvas service, its merge and its hidden worker window all move to the
   client side of the line. Board files stay on the server's disk and are read,
   written and watched through a small `files` subset of the protocol. That
   file access is the only canvas-related code the server keeps.
4. **The fixed capability list of parent §6.4 becomes built-in toolsets**
   offered through the same mechanism. `browser-pane` becomes `browser`, and
   `canvas-render` becomes `canvas`. `editor`, `tour` and `terminal` follow in
   phase 6 (section 10.6). `notify`, `reveal-tab` and `cipher` are not agent
   tools and stay client capabilities.

### 1.3 Findings that shape the design

1. **Only some runtimes follow a changing tool list.** The gateway already
   advertises `tools.listChanged` (`src/main/automation/mcp-dispatch.ts:107`)
   and broadcasts `notifications/tools/list_changed` to every socket
   (`mcp-socket-server.ts:236-240`), today only when a module is turned on or
   off live (`app-main.ts:152`). Claude Code acts on it from CLI 2.1.0, and
   OpenCode does too. Codex ignores it, the Cursor agent CLI is reported to
   ignore it, and Grok is unknown (section 5.4). These are upstream
   behaviours, read rather than tested here. The design therefore never relies
   on removing a tool mid-session. Each MCP connection gets a list that only
   grows, and a tool whose client has gone stays listed and answers a clear
   error (5.3).
2. **Only Claude chats are handed the gateway at launch.**
   `claude-agent-provider.ts:735-738` passes it as an Agent SDK MCP server,
   with the chat's identity stamped on it (`withAgentIdentity`), because the
   chat's child loads no project settings (`app-services.ts:571-588`). Codex
   app-server chats are handed only the session's own servers, as `-c`
   overrides (`codex-conversation-provider.ts:774-785`), and ACP chats (Cursor,
   OpenCode, Grok) only the session's own servers on `session/new`
   (`acp-conversation-provider.ts:907-921`). Terminal agents get it at each
   launch: Claude Code (and the CLIs that share its plugin) through the app's
   plugin directory, whose `.mcp.json` carries it; every other CLI with an
   MCP config through an entry pinned into the workspace's own config file,
   `.codex/config.toml`, `.cursor/mcp.json`, `opencode.json` or `.mcp.json`
   (`studio-mcp-sync.ts:104-150`). A Codex or ACP chat can still start the
   gateway from such a pinned entry, left by an earlier terminal launch in
   the same folder, if its CLI reads that file. Studio does not arrange it,
   and an ACP chat's environment has every `SPRINTENGINE_*` variable removed
   (`acp-conversation-provider.ts:451-458`), so that connection declares no
   agent and the gateway files it as `external-local`
   (`mcp-dispatch.ts:189-191`). In practice a Codex or ACP chat has no
   browser or canvas tools today, and this phase does not change that (open
   decision 7).
3. **The gateway does not know conversations, only agents.** (Since R87, a
   launch token proves the agent and its conversation; section 7.6.) A connection is
   identified by the `sprintengine.studio/connect` call the stdio bridge sends
   with `workspaceId` and `agentId` (`mcp-stdio-bridge.mjs:182-193`,
   `mcp-dispatch.ts:181-219`). `{ workspaceId, agentId }` is exactly the Studio
   conversation key (`packages/studio-protocol/src/key.ts`), so per-conversation
   scoping is per-connection scoping. On the local socket that identity is
   advisory, as it already is for every gateway tool (`mcp-socket-server.ts:108-111`).
4. **`tools/list` is global today.** It returns one resolved list with a
   five-minute `ttlMs` (`mcp-dispatch.ts:36-44`, `:116-125`). The only filter
   is the tailnet device gate. Client tools need it to be per connection.
5. **No server-to-client call exists yet.** The built envelope has
   `welcome | res | frame | push | subFailed | chunk | bye`
   (`packages/studio-protocol/src/envelope.ts:173-180`). The parent's `call` and
   `reply` frames (§5.1) were sketched and never built. `hello.client.capabilities`
   is parsed (`envelope.ts:325`) and stored nowhere.
6. **Every result already fits one frame.** The gateway refuses a line over
   1 MiB (`mcp-socket-server.ts:39`, the bridge at `mcp-stdio-bridge.mjs:67`),
   so every tool result an agent can receive is under 1 MiB of JSON. The canvas
   screenshot ladder is sized for that (`canvas-service.ts:1419-1485`: PNG
   ≤ 600 KB, then JPEG ≤ 900 KB), and a browser screenshot is a JPEG at quality
   80 with a 1024 px edge (`browser-control.ts:26-33`). The largest client frame
   is about 1.26 MB (`CONVERSATION_MAX_CLIENT_FRAME_BYTES`,
   `packages/conversation-protocol/src/index.ts:51`). A reply therefore needs
   neither binary frames nor client-side chunking.
7. **The canvas service is already portable.** It imports only `node:crypto`
   and `node:path`, and takes its filesystem as an injected `CanvasFs`
   (`canvas-node-fs.ts`, 64 lines: `readFile`, `writeFile`, `writeBytes`,
   `rename`, `mkdir`, `stat`, `readdir`, `unlink`, and a directory watcher). A
   `CanvasFs` over the protocol lets the whole service run in a client against
   a remote server's disk, unchanged except for one atomic-write hook (10.3).

## 2. Where things stand

### 2.1 The gateway

- A hand-written JSON-RPC server, newline-delimited over the automation socket
  or named pipe (`mcp-socket-server.ts:24-29`). Its methods are `initialize`,
  `ping`, `tools/list`, `tools/call` and `sprintengine.studio/connect`
  (`mcp-dispatch.ts:89-152`). The tailnet listener reuses the same dispatcher.
- Tools are `McpToolRegistration { name, description, inputSchema, mutates?,
  handler(args, context) }` returning `McpToolResult` (text and `image`
  content, `structuredContent`, `isError`) (`src/shared/modules/mcp-tools.ts:11-36`).
- `createStudioGateway` (`src/server/core/studio-gateway.ts:51-118`) composes
  the core's tools with the shell's `appTools`. The desktop passes browser,
  canvas, editor, tour, the core tools and its automation tools, in that order
  (`src/main/app-services.ts:1341-1373`). A standalone server serves the core
  tools alone (`src/server/studio-server.ts:205`).
- Module tools are re-read on every request, and a disabled module's tools
  stay listed and answer one actionable sentence
  (`studio-gateway-tools.ts:97-147`). This phase reuses that rule.
- Mutations are a fixed set (`studio-gateway-tools.ts:13-63`). A third-party
  module's tool counts as a mutation unless it says `mutates: false`
  (`mcp-tools.ts:31-33`, `main-host.ts:619`).
- Audit: `sprintengine-studio-mcp-audit.jsonl` (`gateway-audit.ts:7`), with
  mutations only on the local socket and refusals as well on the tailnet.
- There is no per-call deadline in the gateway. Each tool keeps its own:
  browser open 8 s plus load 15 s, `wait_for` up to 30 s, `evaluate` 30 s;
  canvas worker 20 s (60 s for mermaid) plus 15 s cold start
  (`canvas-worker-host.ts:28-34`).

### 2.2 The browser tools

- `browser-tools.ts` (725 lines), `browser-control.ts` (957),
  `browser-manager.ts` (1,052). All three are Electron-side, and the boundary
  test keeps them there (`src/server/electron-boundary.test.ts:30-33`).
- Tools: `status`, `snapshot`, `screenshot`, `wait_for`, `console`, `actions`
  and `network` read. `open`, `navigate`, `click`, `hover`, `type`, `press`,
  `scroll`, `evaluate`, `resize` and `set_appearance` mutate
  (`browser-tools.ts:22-33`).
- A tool resolves its workspace from the caller's metadata, and its tab from a
  named `tabId`, then the agent's assigned tab, then the active one
  (`browser-tools.ts:172-227`). `browser.open` with no tab asks the windows to
  open one and waits up to 8 s, else `pane_unavailable` (`:287-326`).
- The person-wins epoch, the snapshot walker, the console and network buffers
  and the screenshot all live in `browser-control.ts`. None of them changes in
  this phase.

### 2.3 The canvas

- `canvas-service.ts` (1,807 lines) owns boards: `<userData>/canvas/ws_<hash>/
  <name>.excalidraw` (`canvas-board-store.ts:28-30`, the hash from
  `deriveWorkspaceId`), and boards an earlier build left in
  `<workspace>/diagrams/` (`src/shared/canvas/paths.ts:30,151`).
- The atomic write is a temp file plus a rename (`canvas-service.ts:599-629`).
  A directory watch with a 150 ms debounce reloads changes from disk
  (`:751-788`), and `settleDisk` runs before every write (`:846`).
- The merge is per element, last writer wins by `version` and `versionNonce`
  (`src/shared/canvas/merge.ts:30,54`). The person wins through
  `runAgentMutation` (`canvas-service.ts:1052-1116`): if the person changed an
  element the agent's edit moved, the edit is retried once and then answered
  `interrupted`. Changes read from disk count as the person's, because
  `settleDisk` runs before the collision test.
- Worker calls (`edit`, `layout`, `import`, `screenshot`) go to a hidden
  `BrowserWindow` (`canvas-worker-window.ts`, 282 lines) behind the
  transport-neutral `CanvasWorkerTransport` (`canvas-worker-host.ts:36-46`).
- Panes are fed by IPC pushes: `canvas:scene`, `canvas:presence` and
  `canvas:open-request` (`canvas-service.ts:58-60,655,670`), keyed by
  WebContents in `canvas-subscribers.ts`. The preload has 13 canvas channels
  (`src/preload/api/canvas.ts`).
- The service and `canvas-tools.ts` (938 lines) are on the server-bound list
  (`electron-boundary.test.ts:81,86-87`). They are still constructed in main
  (`app-services.ts:1219-1240`). `studio-core.ts:54` defers them to "the render
  host, phase 5", which this spec withdraws.

### 2.4 The protocol, the grants and the SDK

- A grant is `{ clientId, name, owner, scopes, ceiling }`
  (`envelope.ts:90-96`). The owner grant has every scope (`studio-local-app-store.ts:76-82`).
  Every owner connection shares the client id `owner` (`:44`), so a client id
  does not tell two desktops apart.
- Studio's own windows attach over a port with `ownWindow: true`
  (`src/main/studio-rpc/studio-rpc-service.ts:316-323`). That is the in-process
  precedent for a connection whose kind the transport, not the client, asserts.
- Scopes: `conversation:read|operate|create`, `providers:read`, `files:read`,
  `workspaces:read` (`scopes.ts:19-26`).
- `uploads.begin/append/discard` already stage bytes in 512 KB pieces
  (`chat.ts:50-56,172-178`), for pictures up to 5 MB.
- The SDK (`packages/agent-sdk/src/client.ts`, 983 lines) has `request`,
  `subscribe` for push topics, reconnection with backoff, and a heartbeat. It
  sends `hello` without capabilities (`client.ts:717-724`).

## 3. The model

### 3.1 Toolsets and names

A **toolset** is a named group of tools offered by one client connection. An
agent sees each tool under its **wire name**, `<toolset>.<tool>`. MCP clients
that do not accept a dot rewrite it (`browser_open`), as they already do for
every gateway tool (`approvalRules.ts:624-626` matches both spellings).

| | Built-in toolset | App toolset |
| --- | --- | --- |
| Names | `browser`, `canvas` in this phase; `editor`, `tour`, `terminal` in phase 6 | anything matching the pattern that is not reserved |
| Toolset name | as it is today | `^[a-z][a-z0-9-]{1,15}$`. No underscore, so a rewritten wire name splits unambiguously at its first `_`. |
| Tool name | today's names, unchanged (`set_appearance`, `wait_for`) | `^[a-z][a-z0-9_]{0,31}$` |
| Who may offer it | a client with the shell role (7.2) | a client whose grant holds `tools:offer` |
| Reach | every gateway connection on the server, as today | the conversations the app started, plus those the owner granted (5.2) |
| `mutates` | declared per tool, from today's mutation sets | defaults to `true`; only an explicit `false` makes a tool a read, the third-party module rule |

**Reserved names** can never be taken by an app. They are every built-in
toolset name, every family prefix a core tool uses (`agent`, `backlog`, `cli`,
`conversation`, `editor`, `marketplace`, `module`, `schedule`, `tailnet`,
`terminal`, `tour`, `workspace`, …, computed from the core registrations at
start), every module id, and `studio`, `sprintengine` and `app`.

**Name binding.** An app's toolset name is bound to its pairing the first time
the app offers it. The binding is kept in `<dataDir>/client-toolsets.json`
(0600). Another app that offers the same name is refused `name_taken`. The
binding lasts as long as the pairing. Revoking the app deletes the binding
together with every approval rule that names one of its wire names (7.3), so a
later app that takes the name inherits nothing. Owner connections share one
client id and therefore one set of bindings, which is right: an owner is the
person.

### 3.2 Lifecycle of a call

```
 agent CLI            gateway (server)                         client (desktop or app)
    │  tools/call         │                                          │
    │  browser.open ─────▶│ registry: visible to this connection?    │
    │                     │ route: conversation → client (6)         │
    │                     │──── call {id, toolset, tool, input,  ───▶│ handler runs
    │                     │           context, timeoutMs}            │ (browser-tools.ts
    │                     │◀─── progress {id, message} ──────────────│  against the pane)
    │◀ notifications/     │                                          │
    │  progress (if asked)│◀─── reply {id, ok, result} ──────────────│
    │◀── MCP result ──────│ audit (mutations), drop late replies     │
```

The server never runs a client tool's logic. It checks visibility, picks the
client, enforces the deadline and size limits, forwards cancellation, and
audits.

## 4. Protocol

All of this is additive to Studio protocol version 1. A new welcome capability,
`client-tools`, tells a client the server accepts offers. A client that never
offers never receives a `call`. The new frame types are sent only to a
connection that has offered a toolset, and the SDK sends `reply` and
`progress` only to a server that advertised `client-tools`. An older peer is
therefore never handed a frame type it does not know.

The protocol additions live in a new file, `packages/studio-protocol/src/tools.ts`,
re-exported from `public.ts`.

### 4.1 `hello` additions

```ts
export type StudioClientInfo = {
  name: string
  version?: string
  capabilities?: string[]
  /** What kind of client this is. Read only from an owner grant; any other grant is an `app`. */
  kind?: 'desktop' | 'web' | 'app' | 'headless'
  /**
   * Random per process run, the same across that process's reconnects. It is
   * how the server tells two desktops on one owner grant apart, and how it
   * knows a reconnect is the same process (redelivery, 8.3).
   */
  instanceId?: string // 16–64 chars, [A-Za-z0-9_-]
}
```

A transport that knows better overrides `kind`. The desktop's in-process port
and, in phase 6, its control channel attach with `shell: true`, beside today's
`ownWindow` (`studio-rpc-server.ts:69`), and that is what makes a connection
the shell (7.2).

### 4.2 Methods and topics

| Method / topic | Scope | Owner only | Mutation | Shape |
| --- | --- | --- | --- | --- |
| `tools.offer` | `tools:offer` | no | no (idempotent: a second offer of the same toolset replaces the first) | `{ toolset: StudioToolsetOffer, reach?: 'own' \| 'all' }` → `{ toolset, wireNames: string[], reach }`. `reach` is honoured from owners only; an app's reach comes from its pairing (5.2). |
| `tools.withdraw` | `tools:offer` | no | no | `{ toolset }` → `{ withdrawn: boolean }` |
| `tools.focus` | `tools:offer` | no | no | `{ focused: boolean, workspaceIds: string[], activeWorkspaceId?: string }` → `{}`. A routing hint (6.3). |
| `tools.catalog` | `conversation:read` | no | no | `{}` → `{ toolsets: StudioToolsetListing[] }`. An app sees its own toolsets and the built-ins. An owner sees all of them. |
| topic `tools.catalog` (push) | `conversation:read` | no | no | the same listing, whole, on every change. The chat view labels a tool's origin with it (5.5). |
| `tools.grant` | `conversation:operate` | yes | yes (`commandId`) | `{ key, toolset, granted: boolean, commandId }` → `{ grants: string[] }`. Opens or closes one conversation to one app toolset (5.2). |
| `files.*` subset | see 10.3 | yes | see 10.3 | board file access for the canvas toolset |

`STUDIO_SCOPES` gains `tools:offer` and `files:write` (`scopes.ts:19-26`). The
owner grant picks them up automatically (`studio-local-app-store.ts:81`). A
pairing stored earlier never gains them, by the existing rule that a grant
holds exactly the names it was given.

### 4.3 The offer

```ts
export type StudioToolSpec = {
  name: string                          // 3.1 patterns
  description: string                   // 1–2,000 characters
  inputSchema: Record<string, unknown>  // JSON Schema; root `type: 'object'`; ≤ 16 KiB as JSON
  mutates?: boolean                     // apps: default true
  timeoutMs?: number                    // 1,000–600,000; default 60,000
}

export type StudioToolsetOffer = {
  name: string
  /** Shown to the person: "Acme Game". Defaults to the grant's name. ≤ 60 characters. */
  title?: string
  /** One sentence for the agent, placed before each tool's description (5.5). ≤ 300 characters. */
  description?: string
  tools: StudioToolSpec[]               // 1–32
}

export type StudioToolsetListing = {
  name: string
  title: string
  builtIn: boolean
  offeredBy: Array<{ clientName: string; kind: StudioClientInfo['kind']; instanceId: string; connected: boolean }>
  tools: Array<{ name: string; wireName: string; mutates: boolean }>
}
```

`parseStudioToolsetOffer` validates the patterns, the counts, the sizes and the
schema's root, and checks that each tool's `inputSchema` uses no `$ref` outside
the document. It does not validate the schema further: the client owns the
handler and checks its own input, as every gateway tool does today.

### 4.4 Frames

```ts
// Studio → client
export type StudioCallFrame = {
  t: 'call'
  id: string                 // minted by the server; unique for the server's lifetime
  toolset: string
  tool: string
  input: Record<string, unknown>
  context: StudioToolCallContext
  timeoutMs: number          // what the server will wait, from the offer
  /** Set when this id was sent before, to an earlier connection of the same instance (8.3). */
  redelivery?: true
}
export type StudioCancelFrame = {
  t: 'cancel'
  id: string
  reason: 'interrupted' | 'agent_gone' | 'timeout' | 'client_replaced' | 'shutting_down'
}

export type StudioToolCallContext = {
  /** The gateway connection's metadata (`McpConnectionMetadata`). Device fields go to the shell only. */
  connection: {
    kind: 'studio-agent' | 'external-local' | 'remote-tailnet'
    workspaceId?: string
    agentId?: string
    agentName?: string
    cliId?: string
    deviceId?: string
    deviceName?: string
  }
  /** Present when the caller is a conversation: its key. */
  conversation?: { workspaceId: string; agentId: string }
}

// client → Studio
export type StudioReplyFrame =
  | { t: 'reply'; id: string; ok: true; result: McpToolResult }
  | { t: 'reply'; id: string; ok: false; error: { code: string; message: string } }
export type StudioProgressFrame = {
  t: 'progress'
  id: string
  progress?: number
  total?: number
  message?: string           // ≤ 200 characters
}
```

`SERVER_FRAME_TYPES` (`envelope.ts:370`) gains `call` and `cancel`.
`parseStudioClientFrame` (`envelope.ts:301-356`) gains `reply` and `progress`.
Neither is ever answered: a bad `reply` is logged and dropped, never refused
with a `res`. A client with no offer that sends a `reply` is closed
with `bye invalid_frame`, as for any frame out of place.

`ok: true` with `result.isError: true` is a tool-level failure the agent should
read (`no_tab`, `interrupted`). `ok: false` is a failure of the client
(`tool_failed`, `invalid_input`, `unknown_tool`, `cancelled`). The server turns
it into today's `toolError(code, message)` shape (`mcp-tools.ts:75-81`), so an
agent reads both kinds the same way it reads every gateway error now.

### 4.5 Deadlines and progress

- The server's deadline for a call is the tool's `timeoutMs` plus 5 s of slack
  for the round trip. When it passes, the agent is answered `timeout` and the
  client is sent `cancel { reason: 'timeout' }`.
- A `progress` frame never extends a call past `timeoutMs`. Where the agent's
  `tools/call` carried `_meta.progressToken`, the gateway forwards it as
  `notifications/progress`, a small new path in `mcp-dispatch.ts`, with a
  count that rises by at least one each time (MCP requires it to rise, and a
  client may name no number). Otherwise it is dropped. (Amended as built: the
  spec first had progress reset an idle timer, but no idle timer exists beside
  the deadline, so there was nothing for it to reset.)
- Built-in tools declare timeouts that cover today's internal deadlines:
  `browser.open` 30 s, `browser.wait_for` and `browser.evaluate` 40 s, every
  other browser tool 20 s; `canvas.import` 90 s, `canvas.edit`, `layout` and
  `screenshot` 45 s, every other canvas tool 15 s. Behaviour is unchanged,
  because every built-in already answers within its own deadline.

### 4.6 Results and size

- A result is an `McpToolResult`. Content parts are `text` or `image`, and an
  image's `mimeType` is PNG, JPEG, WebP or GIF, which is today's shape.
- The encoded `reply` must be at most `STUDIO_MAX_TOOL_RESULT_BYTES`
  (960 KiB). That keeps the agent's MCP line under the gateway's 1 MiB with
  room for the JSON-RPC envelope. The SDK checks before sending and fails the
  call locally with `too_large`, so the handler's author sees the error where
  it happened. The server checks again.
- There are no binary frames and no client chunks. Screenshots are base64
  inside the image part, as today. A tool that wants to return more than this
  should return a reference (a file it wrote through `files.*`, or a URL) and a
  summary.

### 4.7 Errors

New `STUDIO_ERROR_CODES` for requests: `reserved_name`, `name_taken` and
`not_offered` (for `tools.withdraw` or `tools.grant` naming an unknown
toolset). The counts and sizes in 4.8 answer `too_large` or `busy`, which
already exist.

What an agent can receive from a client tool, beyond the tool's own errors:

| Code | When | Message the agent reads |
| --- | --- | --- |
| `client_unavailable` | listed for this connection, but no client offering it is connected | built-in: "Open Studio on a desktop and connect it to <environment> to use the browser." (canvas: "…to use the canvas.") App: "<App title> is not running. Start it to use <tool>." |
| `tool_withdrawn` | the client withdrew the toolset, or a newer offer from it dropped the tool | "<App title> no longer offers <tool>." |
| `client_disconnected` | the connection dropped during the call and did not come back in time (8.2) | "<Client> disconnected while running <tool>. It may or may not have finished; check before retrying." |
| `timeout` | the deadline passed | "<Client> did not answer <tool> within <n> s." |
| `cancelled` | the turn was interrupted, or the agent cancelled | "Cancelled." |
| `busy` | the client has too many calls in flight (4.8) | "<Client> is busy; retry shortly." with `retryAfterMs` in `structuredContent` |
| `too_large` | the reply was over 4.6's limit | "<tool>'s answer was too large to return." |
| `tool_failed` | the handler threw | the client's message, truncated to 2,000 characters |

### 4.8 Limits

| Limit | Value | Answer when exceeded |
| --- | --- | --- |
| Toolsets per connection | 8 | `too_large` on the offer |
| Tools per toolset | 32 | `too_large` |
| App tools per server, all apps | 256 | `busy` on the offer, naming the limit |
| `inputSchema` size | 16 KiB of JSON | `invalid_params` |
| One offer | 256 KiB of JSON, inside the client frame cap | `too_large` |
| Offers and withdrawals per connection | 20 per minute | `busy` with `retryAfterMs` |
| Calls in flight to one connection | 16 | the agent gets `busy` |
| Calls in flight per gateway connection, to client tools | 8 | the agent gets `busy` |
| Calls started per app, per second | 20 (token bucket, burst 40) | the agent gets `busy` |
| `list_changed` per MCP connection | at most one every 2 s, coalesced | the next one is delayed, never dropped |
| Reply size | 960 KiB encoded | `too_large` |

The limits are constants in `tools.ts`, so a client can read them.

### 4.9 Where it is handled

- `src/server/rpc/studio-rpc-connection.ts` parses `reply` and `progress`,
  sends `call` and `cancel`, and tells the registry when the connection closes.
- `src/server/rpc/studio-rpc-router.ts` registers the `tools.*` and `files.*`
  methods.
- `src/server/tools/client-tool-registry.ts` (new) holds offers per
  connection, name bindings, reach, routing, the in-flight calls, deadlines and
  redelivery.
- `src/server/tools/client-tool-gateway.ts` (new) holds the per-connection
  catalogs (5.3), and turns a listed client tool into an `McpToolRegistration`
  whose handler is `registry.call(...)`.

## 5. Exposure to agents

### 5.1 One gateway, a list per connection

`McpDispatcher` takes `resolveTools(context)` instead of `resolveTools()`
(`mcp-dispatch.ts:116-125`). As built, `createStudioGatewayTools` stays as it
was, Studio's own tools with no context, and the gateway composes the list per
connection: the client gateway's built-ins for that connection, Studio's own
tools, then the apps' toolsets for that connection
(`src/server/core/studio-gateway.ts`). Core and module tools ignore the
context. Client tools are filtered by it. The `ttlMs` stays at five minutes:
it is the floor for a client that ignores notifications, and 5.3 makes a
cached list safe to keep.

`notifyToolsListChanged` (`mcp-socket-server.ts:234-240`) gains a per-socket
form, `notifyToolsListChanged(socket)`, so an offer that one conversation can
see does not make every agent on the machine re-list. The tailnet listener
(`tailnet-gateway-server.ts:1275-1276`) gets the same.

### 5.2 Which client tools a connection sees

| Caller (`connection.kind`) | Built-in toolsets | An app's toolsets |
| --- | --- | --- |
| `studio-agent` in a conversation the app started | yes | yes |
| `studio-agent` in a conversation the owner granted it to (`tools.grant`) | yes | yes |
| `studio-agent`, any conversation, when the app's reach is `all` | yes | yes |
| any other `studio-agent` (a chat or terminal agent) | yes | no |
| `external-local` (no agent id: a CLI the person started, or a chat that loaded a pinned entry, finding 2) | yes | only with reach `all` |
| `remote-tailnet` | as today, through the device's scope gate | no, in v1 |

- "Started" means the conversation's agent record names the app. A chat a
  client starts is launched under its namespaced command id
  (`client:<clientId>:<commandId>`, or `owner:<commandId>`), and the agent
  record already keeps that id (`launchCommandId`), so the client is read from
  it (`conversationStartedBy`, `studio-conversation-backend.ts`) and nothing new
  is written to the record. Which process of the client started it, for routing
  (6.2 step 4), is kept in memory by the registry from `conversation.create`'s
  answer. (Amended as built: the spec first had `conversation.create` write a
  new `startedBy` member, which would have duplicated what the record holds.)
- An app's reach is a setting on its pairing (`toolReach` in
  `studio-local-apps.json`): "its tools reach the conversations it starts"
  (default) or "every conversation and terminal agent on this machine". It is
  shown and changed in Settings beside its scopes. Unlike the scopes, which are
  fixed at pairing, it may be changed at any time. A pairing stored before this
  phase reads as `own`. An owner script passes `reach` on the offer instead.
- A built-in toolset reaches every caller, because today every caller sees the
  browser and canvas tools. This keeps parity.

### 5.3 A stable list per connection

Each MCP connection keeps a **catalog**: the client tools it has been shown,
by wire name, with the latest definition.

1. **First `tools/list`.** The catalog is filled with every client tool
   visible to the connection (5.2) whose toolset has a connected offer.
2. **A new offer later** (a desktop attaches, an app starts, or an owner
   grants a toolset). Every connection that can now see a tool not in its
   catalog adds it and is sent `notifications/tools/list_changed`, coalesced
   (4.8). A runtime that honours the notification lists the tool from its next
   turn. One that does not lists it at its next session.
3. **The offering client disconnects, or withdraws.** Nothing is removed. The
   tool stays listed, and a call answers `client_unavailable` or
   `tool_withdrawn` (4.7) until a client offers it again. Then the same wire
   name works again with no notification needed.
4. **A re-offer changes a definition** (a newer desktop, an app update). The
   catalog keeps the newest definition and sends `list_changed`. A tool the new
   offer dropped stays listed and answers `tool_withdrawn`.
5. **The connection ends.** Its catalog is dropped. The next session starts
   from step 1. A stdio bridge that reconnects across a server restart
   (phase 6 §6.5) is a new connection to the gateway while the agent still
   holds its old list, and the shell or an app may not have re-offered yet.
   So a call to a wire name the new catalog lacks, whose toolset is built in
   or bound to a pairing (3.1), is answered `client_unavailable` rather than
   as an unknown tool, and the tool joins the catalog when its toolset is
   offered again.

Why tools are never removed mid-connection:

- A runtime that ignores the notification would keep calling a tool that is
  gone. Its result would be "unknown tool", which is a worse message than
  `client_unavailable` and, for Codex, a JSON-RPC error rather than a result.
- Removing tools invalidates the agent's prompt cache and, on Claude Code, the
  ToolSearch index. The index is not refreshed today (an open upstream issue,
  anthropics/claude-code#66084).
- It is the rule the gateway already applies to a disabled module
  (`studio-gateway-tools.ts:122-147`): stay listed, answer one actionable
  sentence.

**Boot.** A desktop's own local server lists the shell's toolsets from the
first `tools/list`, exactly as today. The desktop composition passes
`expectShellToolsets: ['browser', 'canvas']`. On that server, a `tools/list`
that arrives before the shell has offered them waits for those offers, up to
5 s. Agents only launch after `whenGatewayReady` (`studio-gateway.ts:113-116`),
and the shell offers immediately after it attaches, so the wait is normally
zero. A standalone, WSL or SSH server sets no expectation and never waits.

### 5.4 Each runtime

| Runtime | Gets the gateway today | Honours `list_changed` | What the person sees when a client connects mid-session |
| --- | --- | --- | --- |
| Claude Code via the Agent SDK (chat) | yes, handed it at launch with its identity (`claude-agent-provider.ts:735-738,789`) | yes from CLI 2.1.0, only when the server declares `tools.listChanged`, which it does. From 2.1.267, tools added mid-session reach the model as deferred definitions found through ToolSearch. | the tools appear from the next turn |
| Claude Code in a terminal | yes, through the app's plugin directory at launch | as the chat | as the chat |
| Codex app-server (chat) | no; only from an entry a terminal launch pinned into the workspace's `.codex/config.toml`, if the CLI reads it | no: `on_tool_list_changed` only logs (codex `rmcp-client/src/logging_client_handler.rs`) | at the next thread, once it has the gateway |
| Codex in a terminal | yes, the pinned workspace entry | no | at the next session |
| OpenCode over ACP (chat) | no; only from a pinned `opencode.json` entry, with no identity | yes (`packages/opencode/src/mcp/index.ts`) | next turn, once the gateway is passed to ACP sessions |
| Cursor agent CLI over ACP (chat) | no; only from a pinned `.cursor/mcp.json` entry, with no identity | reported not to | at the next session |
| Grok CLI over ACP (chat) | no; only from a pinned `.mcp.json` entry, with no identity | unknown; treated as no | at the next session |
| OpenCode, Cursor and Grok in a terminal | yes, the pinned workspace entry | as their chats | as their chats |

Studio drives no other ACP runtime today (`ACP_PROFILES`,
`acp-conversation-provider.ts:118-170`). Every runtime gets its gateway entry
once, at launch, and nothing re-syncs it during a session.

The Agent SDK can also add or remove whole MCP servers on a live session
(`setMcpServers` in the installed SDK's `sdk.d.ts`). This design does not need it: the gateway
is one server whose list grows.

### 5.5 What the agent and the person read

- **Description.** The gateway puts an app toolset's origin before every tool's
  description: `[From Acme Game, an app connected to Studio.] <toolset
  description> <tool description>`. Built-in descriptions are passed through
  unchanged, so prompts and skills that quote them still match.
- **Order.** `tools/list` keeps today's order. The built-in toolsets fill the
  slots the desktop composition gave `createBrowserTools` and
  `createCanvasTools` (`app-services.ts:1342-1353`): first, before editor and
  tour. App toolsets come after every core and module tool, sorted by name.
- **Origin in the chat.** The chat view subscribes to `tools.catalog` and
  labels a tool row or an approval card whose wire name belongs to an app
  toolset with the app's title ("from Acme Game"). This needs no change to the
  conversation contract: the label is resolved client-side from the tool name
  the approval already carries (`mcpCallOf`, `approvalRules.ts:629-632`).

## 6. Routing

### 6.1 Candidates

For a call from connection C, possibly in conversation K, to toolset T, the
candidates are the connected offers of T that are visible to C (5.2). For an
app toolset that is one app, possibly with several connections. For a built-in
it can be several shells: two desktops attached to one SSH server, or later a
desktop and a headless client.

### 6.2 Order of preference

1. **Affinity.** If K already routed T to an instance that still offers it,
   that instance. A browser tab, a canvas worker's warm state and a game's
   session all live in one client, so a conversation's calls must not hop.
   Affinity is per (conversation, toolset), or per gateway connection when
   there is no conversation. It survives the instance reconnecting (8.2).
2. **The client the person is looking at.** An instance whose last
   `tools.focus` said `focused: true` and listed K's workspace.
3. **The client showing the workspace.** An instance whose `workspaceIds`
   include K's workspace.
4. **The client that started K** (`startedBy.instanceId`), if still connected.
5. **By kind, for built-ins.** `desktop` before `web` before `headless`: a
   person can see and take over a desktop pane; a headless browser shows them
   nothing.
6. **Most recently focused**, then most recent offer.

The first call sets the affinity. When the affinity's instance is gone for
good (8.2) the next call routes afresh, and the result's first text part is
prefixed: "The browser is now in <client name>. Tab ids from before no longer
apply." That is the one case where an agent's view of a client changes under
it, so it is told.

### 6.3 Focus hints

The desktop sends `tools.focus` when one of its windows gains or loses focus,
or changes the workspaces it shows, debounced to 500 ms. This is the same
information phase 6's shell `focus` hint carries, sent over the protocol so a
remote server gets it too. An app may send it. It only changes routing among
that app's own instances.

### 6.4 Several connections of one app

An app may hold up to eight connections (`maxConnectionsPerClient`,
`studio-rpc-server.ts:59,78`). Each connection's offer stands alone. Routing
among them uses 6.2. The registry treats instances, not connections, as the
unit, so a reconnect is the same instance.

## 7. Permissions, approval and security

### 7.1 Who may offer

- `tools:offer` is a new scope. Settings' pairing dialog shows it as "Give
  agents tools from this app", off by default. The owner has it.
- Tailnet pairings never hold it in v1. The phone offers no tools, and a
  remote device giving agents on this machine tools is a separate decision.
- **Scopes are not a sandbox** (parent §9.2). A paired app runs as the same OS
  user. The scope and the reach protect against a mistake in a trusted app, not
  against a malicious one.

### 7.2 Built-in names and the shell role

Only a connection with the **shell role** may offer a built-in toolset. Any
other connection that tries is refused `reserved_name`.

| Route | How the shell role is established |
| --- | --- |
| Desktop and its in-process server (phases 1–5) | main attaches its own client over a port with `shell: true`, the way windows attach with `ownWindow: true` (`studio-rpc-service.ts:316-323`) |
| Desktop and its out-of-process local server (phase 6) | the control channel, which is process-private (phase 6 §4) |
| Desktop and a WSL, SSH or standalone server | an owner grant and `hello.client.kind: 'desktop'` |
| Web client (phase 9), for `canvas` only | an owner grant and `kind: 'web'` (phase 9 §3.8, decisions R79) |
| Headless client (section 14, later) | an owner grant and `kind: 'headless'` |

As built, an owner connection whose hello says `kind: 'desktop'` is the shell
on every route, the desktop's own in-process server included: in phases 1–5
the owner token never leaves the desktop's process, so only the desktop can
say it. A `kind: 'headless'` owner may offer `browser` and `canvas`, and a
`kind: 'web'` owner `canvas` only.

On the last three routes the role rests on the owner credential. Anything that
holds the owner token on the server's host (`<dataDir>/run/owner-token`, 0600)
can already do everything the owner can, so the reservation does not try to
keep owner-level code out. It keeps paired apps out, and it keeps an owner
script from taking a built-in name by accident.

The shell role may also offer a reserved family that the server does not
serve itself: the WSL front door forwards `backlog.*` and the module tools
still wired on the Windows side to a WSL server this way (phase 7 §3.7). A
name the server registers itself is refused `reserved_name` to every client,
the shell included, so no offer can shadow a core or module tool.

### 7.3 Approval

- A client tool goes through the calling agent's permission mode exactly like
  any MCP tool. For a Claude chat that is the SDK's permission check, Studio's
  approval card and the saved rules. A rule matches
  `mcp__<server>__<toolset>_<tool>` (`approvalRules.ts:629-660`).
- The card shows the origin (5.5), so "allow" on `game_spawn_enemy` is visibly
  an allow for Acme Game.
- **Rules die with the app.** Revoking a pairing deletes every saved approval
  rule whose tool is one of that app's wire names
  (`conversation-approval-rules.ts`), in the same write as the revocation. The
  name binding goes too (3.1). A different app that later takes the same name
  inherits no "always allow".
- The launch cap (`launch-permission-cap.ts`) does not apply. A client tool
  runs in the client, not as a Studio agent launch. An app that starts a
  conversation from inside a handler does it through its own grant and its own
  ceiling.
- None of an app's tools is ever added to `AGENT_LAUNCHING_GATEWAY_TOOLS`
  (`approvalRules.ts:614-622`). An app tool that happens to start agents
  through the app's own grant is the app's responsibility, under its ceiling.

### 7.4 What an app's tools can do to an agent

An app's descriptions and results reach the agent's context. They are as
untrusted as a web page the agent reads. The origin prefix (5.5) tells the
agent where they came from. Results are size-capped (4.6) and passed through,
never interpreted by the server. Nothing an app returns can change the agent's
permission mode, its tools or its conversation.

### 7.5 Audit

The gateway audit (`gateway-audit.ts`) records:

- every call of a client tool that mutates, as for any gateway mutation, with
  a new `servedBy: { clientId, clientName, instanceId, kind }`;
- refusals on the tailnet, as today.

The Studio RPC audit (`StudioAuditEntry`, `studio-rpc-types.ts:187-198`)
records `tools.offer`, `tools.withdraw` and `tools.grant` with the toolset name
and the number of tools. It never records input or results.

### 7.6 Which conversation a connection is (R87)

Finding 3 says a gateway connection's identity is advisory: anything that can
open the socket can declare any agent. An app's tools reach the conversations
it started, so a declared identity would let any local agent reach them. Owner
ruling 2026-10-02 (decisions R87): every agent launch is issued its own gateway
token bound to its conversation, and the gateway takes the conversation from
the token, never from what the connection declares.

- `src/server/core/gateway-launch-tokens.ts` issues, resolves and revokes the
  tokens, kept as their SHA-256 in the process that runs the gateway, so a
  restart voids them all as it ends every launch.
- The token rides in `MCP_CHANNEL_TOKEN_ENV`, the variable a WSL launch
  already carried its channel token in, so every path that hands that variable
  to the bridge (a terminal's environment, a WSL startup script, Codex's
  `env_vars`, a chat child's stdin inside a distribution) carries it unchanged.
  In WSL the channel token *is* the gateway token: the helper checks it to open
  the channel, and the gateway resolves the same value.
- Issued for every terminal agent launch (`terminal-runtime.ts`), every chat
  child started through `spawnCliHostChild` whose environment names its
  conversation, and a local Claude chat's child (`claude-agent-provider.ts`).
  Revoked when the session or child ends. An ACP chat's environment carries no
  identity, so it is issued none, which matches finding 2 until R86 lands.
- The bridge sends it as `launchToken` on `sprintengine.studio/connect`, on
  the local socket only. A valid token sets the connection's agent and binds
  its conversation; once bound, a second launch's token is refused. A token no
  live launch holds proves nothing, and the declared identity stays the claim
  it always was. A tailnet connection never takes a launch's identity.
- Only a bound conversation counts for an app's reach (5.2). The launch cap and
  the audit read the same metadata, which the token now proves where present.
- A launch token the app's own process inherited (Studio started from inside
  an agent's terminal) is stripped from every child that is not that launch.

## 8. Disconnect, reconnect, cancellation and idempotency

### 8.1 States of a call

| State | Leaves by | Agent is answered |
| --- | --- | --- |
| `sent` | `reply` | the result |
| `sent` | deadline | `timeout`; the client gets `cancel` |
| `sent` | cancellation (8.4) | `cancelled` at once; the client gets `cancel` |
| `sent` | connection drop | → `orphaned` |
| `orphaned` | the same instance reconnects within the grace and re-offers | → `sent` again, as a redelivery |
| `orphaned` | grace ends; the tool is a read | re-routed once to another candidate, else `client_disconnected` |
| `orphaned` | grace ends; the tool mutates | `client_disconnected` ("may or may not have finished") |

A `reply` for a call that has already been answered is dropped and logged.
Withdrawing a toolset does not cut short a call already `sent`: the client
may still reply, and otherwise the deadline or a `cancel` (8.4) ends it. Only
calls routed after the withdrawal are answered `tool_withdrawn`.

### 8.2 The grace

- An instance whose connection drops stays in the registry for **20 s**: its
  offers, its affinities and its orphaned calls. That covers the SDK's
  reconnect (`client.ts` backoff) across a short network blip or a laptop
  waking.
- New calls routed to it during the grace wait for it, within their own
  deadline. They are not re-routed, because affinity matters more than a few
  seconds.
- After the grace the instance's offers go, and its affinities are cleared.
  Its tools stay in every catalog that listed them (5.3).
- An owner can see this live in Settings → Connected apps: each instance, its
  toolsets, and "reconnecting".

### 8.3 Redelivery and the SDK's memory of calls

- On reconnect, the SDK re-offers its toolsets first, then the server re-sends
  each orphaned call with the same `id` and `redelivery: true`.
- The SDK keeps every call id it has seen for 10 minutes: running ones with
  their promise, finished ones with their reply. A redelivered id joins the
  running handler or is answered from the stored reply, so **a handler never
  runs twice for one call within one process**.
- A different `instanceId` means the process restarted and its memory of calls
  is gone. Orphaned calls to the old instance are then never redelivered to the
  new one. Reads are re-routed once. Mutations are answered
  `client_disconnected`.
- So a mutation runs at most once, and a read is retried at most once.

### 8.4 Cancellation

A call is cancelled, and the client sent `cancel`, when any of these happens:

- **The turn is interrupted.** `conversation.interrupt` and the chat's stop
  reach the conversation runtime, which tells the registry
  `cancelCallsFor({ workspaceId, agentId })`. This does not depend on the
  agent's CLI cancelling its MCP request.
- **The agent cancels.** The gateway handles MCP `notifications/cancelled` for
  a `tools/call` it is running, a small addition to `mcp-dispatch.ts`. The
  local socket answers a connection's requests one at a time, so it handles a
  cancellation as soon as it arrives rather than queueing it behind the call
  it is about.
- **The agent goes away.** Its gateway socket closes (`agent_gone`).
- **The deadline passes** (`timeout`).
- **The server shuts down** (`shutting_down`).

In the SDK, `cancel` aborts the handler's `AbortSignal`. The agent has already
been answered, and a later reply is dropped. Today's built-in handlers take no
signal: a cancelled `browser.wait_for` keeps polling in the pane until its own
deadline, harmlessly. Threading the signal into `browser-control.ts`'s waits is
a follow-up.

### 8.5 A server restart

Calls in flight fail with the agent's own gateway connection, which a restart
drops (phase 6 §6.5 covers the bridge). The SDK reconnects with backoff and
re-offers. No call is redelivered across a server restart, because the server
has no memory of it. A call the agent makes after its bridge has reconnected,
before the client has re-offered, answers `client_unavailable` (5.3, step 5).

## 9. The SDK

### 9.1 API

```ts
// packages/agent-sdk/src/tools.ts
export type ToolHandler<I = Record<string, unknown>> = (input: I, call: ToolCall) => Promise<ToolAnswer> | ToolAnswer

export type ToolCall = {
  id: string
  toolset: string
  tool: string
  conversation: ConversationRef | null   // the calling chat, when there is one
  agent: { name?: string; cli?: string }
  context: StudioToolCallContext         // as the call frame carries it (added as built: 9.3 reads it)
  signal: AbortSignal                    // aborted on cancel
  /** True when this id reached an earlier connection of this process first. */
  redelivered: boolean
  progress(update: { progress?: number; total?: number; message?: string }): void
}

/** A string is one text part; `toolResult` builds the rest; an MCP result passes as is. */
export type ToolAnswer = string | McpToolResult

export type ToolDefinition<I = Record<string, unknown>> = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mutates?: boolean
  timeoutMs?: number
  handler: ToolHandler<I>
}

export type OfferedToolset = {
  readonly name: string
  readonly wireNames: readonly string[]
  /** 'offered' while the server holds it; 'pending' while reconnecting. */
  readonly state: 'offered' | 'pending' | 'withdrawn'
  withdraw(): Promise<void>
}

export type StudioClient = /* existing members */ & {
  readonly tools: {
    offer(toolset: {
      name: string
      title?: string
      description?: string
      reach?: 'own' | 'all'
      tools: ToolDefinition<any>[]
    }): Promise<OfferedToolset>
    /** Tell Studio which workspaces this client is showing (routing hint). */
    focus(hint: { focused: boolean; workspaceIds: string[]; activeWorkspaceId?: string }): void
    catalog(): Promise<StudioToolsetListing[]>
  }
}

export const toolResult: {
  text(text: string, structured?: Record<string, unknown>): McpToolResult
  image(bytes: Uint8Array, mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', caption?: string): McpToolResult
  error(code: string, message: string): McpToolResult   // isError, today's toolError shape
}
```

Behaviour:

- `offer` validates locally with `parseStudioToolsetOffer` first, so a bad
  schema fails in the app with a message, not as a refusal from the server.
- The SDK re-offers every live toolset on each new connection, before it
  resumes anything else. `state` is `pending` in between.
- A handler that throws is answered `ok: false, tool_failed` with the error's
  message. A `StudioToolError(code, message)` thrown from a handler becomes a
  tool-level `isError` result with that code.
- Results over 960 KiB fail locally with `too_large` (4.6).
- Offering needs `supports('client-tools')`. Without it, `offer` rejects with
  `unsupported`.
- As built: the SDK mints the `instanceId` once per `connect()` and sends it
  with every hello, and `ConnectOptions.client` takes `kind`. `ToolCall`
  carries the call's `context`, which the desktop's adapter (9.3) rebuilds a
  gateway handler's `McpConnectionContext` from. `StudioToolError` is exported
  beside `toolResult`.

### 9.2 Example

```ts
import { connect, toolResult } from '@sprintengine/agent-sdk'
import { ownerSocketTransport } from '@sprintengine/agent-sdk/node'

const studio = await connect({
  transport: ownerSocketTransport(),
  client: { name: 'Acme Game' },
  auth: { token: process.env.STUDIO_TOKEN! },
})

const game = await studio.tools.offer({
  name: 'game',
  title: 'Acme Game',
  description: 'Controls the level running in Acme Game on this machine.',
  tools: [
    {
      name: 'spawn_enemy',
      description: 'Spawn an enemy at a grid cell. Answers the new enemy id.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { enum: ['slime', 'bat'] },
          x: { type: 'integer', minimum: 0 },
          y: { type: 'integer', minimum: 0 },
        },
        required: ['kind', 'x', 'y'],
        additionalProperties: false,
      },
      timeoutMs: 10_000,
      async handler({ kind, x, y }, call) {
        const id = await level.spawn(kind as string, x as number, y as number, { signal: call.signal })
        return toolResult.text(`Spawned ${kind} #${id} at ${x},${y}.`, { id })
      },
    },
    {
      name: 'screenshot',
      description: 'A PNG of the current frame.',
      inputSchema: { type: 'object', properties: {} },
      mutates: false,
      handler: async () => toolResult.image(await level.capturePng(), 'image/png'),
    },
  ],
})

// A conversation this app starts can use game.spawn_enemy and game.screenshot.
await studio.conversations.create({ workspaceId, prompt: 'Make level 3 harder, then show me.' })
// …
await game.withdraw()
```

### 9.3 The desktop uses the same SDK

The shell's toolsets are offered through `@sprintengine/agent-sdk` over the
port main attaches, as phase 6's R03 already has the SDK take a
`MessagePort` or any duplex. A small adapter, `offerGatewayTools(client, name,
registrations)`, turns today's `McpToolRegistration[]` into tool definitions.
It rebuilds the `McpConnectionContext` the handlers read from
`call.context.connection`, so `createBrowserTools(...)` and
`createCanvasTools(...)` are offered with no change to their code. The client
the app depends on is the public one, as the parent requires (§5.4).

## 10. The desktop's toolsets

### 10.1 `browser`

- **What runs where.** Everything stays in main: `browser-tools.ts`,
  `browser-control.ts`, `browser-manager.ts`, the `<webview>` pane, the
  element-picker guest preload and the person-wins epoch. The server forwards
  calls. Behaviour on a local desktop does not change (11.2 proves it).
- **Per environment.** The desktop offers `browser` on each server connection
  it holds. A tab belongs to a workspace of one environment. Workspace ids are
  path hashes (`workspace-id.ts:15-17`), so two environments can mint the same
  id for the same path. The pane therefore keys tabs by
  `(environmentId, workspaceId)` once it holds more than one connection.
- **No window open.** Today a call with no window answers `pane_unavailable`
  after 8 s. That stays. On a desktop-local server the shell is always
  attached (decisions R01), so the tools are always listed there.

### 10.2 `canvas`: what is client and what is server

| Part | Today | After this phase |
| --- | --- | --- |
| `canvas-tools.ts`, `describe`/`find`/`lint` (shared) | main, server-bound list | **client**: the desktop's `canvas` toolset |
| `canvas-service.ts`: board cache, revisions, merge, person-wins, presence, action log, screenshot ladder, `exportBoard` | main, server-bound list | **client**: one instance per environment connection, in the desktop's main |
| Worker window and host (`canvas-worker-window.ts`, `canvas-worker-host.ts`, `src/renderer/src/canvasWorker/*`) | main | **client**, unchanged |
| `canvas-subscribers.ts`, `canvas-ipc.ts`, the 13 preload channels, `CanvasTab.tsx`, `CanvasEditor.tsx` | main and renderer | **client**, unchanged |
| Board files: `<dataDir>/canvas/ws_<hash>/*.excalidraw`, legacy `<workspace>/diagrams/*.excalidraw` | written by main | **server disk**, read, written and watched through `files.*` (10.3) |

`canvas-service.ts`, `canvas-board-store.ts` and `canvas-tools.ts` leave the
server-bound list in `electron-boundary.test.ts`. They move to a new
**portable** list in the same test: code that must not reach Electron because a
web client or the headless client will run it, but that the server does not
load. The worker window stays Electron-side.

### 10.3 Boards are files

**Where they live.** Where they are today, on the server's disk: the board
store under the server's data directory, and the legacy `diagrams/` folder in
the workspace. Nothing moves, so a person's boards are where they were.
Moving them into the workspace is open decision 1.

**The `files` subset.** Owner only in v1. These are the first members of the
`files` write and watch family the ruling gives the server. The full file
explorer extends them later (parent ruling c).

| Method / topic | Scope | Shape |
| --- | --- | --- |
| `files.roots { workspaceId }` | `files:read` | `{ workspace: true, boards: true }`: which roots exist for that workspace. No absolute paths. |
| `files.stat { root, path }` | `files:read` | `{ stat: { kind: 'file' \| 'directory', size, mtimeMs, hash? } }` or `not_found`. The method exists since phase 4 as `{ path }` with an absolute path (`chat.ts:226`); `root` is an optional addition, and with it `path` is relative. Without `root` it answers as today. |
| `files.list { root, path }` | `files:read` | `{ entries: [{ name, kind }] }`, one level, symlinks reported as neither (as `canvas-node-fs.ts:34-40`) |
| `files.read { root, path }` | `files:read` | `{ text, hash, size, mtimeMs }`. Up to 64 MB; a large answer is chunked by the server (`envelope.ts:491-507`). |
| `files.write { root, path, text \| uploadId, ifMatch, commandId }` | `files:write` | `{ hash, size, mtimeMs }`, or `conflict { currentHash }`. Atomic: a temp file in the same directory, then a rename. Parent directories are created. `ifMatch: null` means create only. |
| `files.remove { root, path, ifMatch, commandId }` | `files:write` | `{ removed: boolean }` or `conflict` |
| topic `files.watch { root, path }` (push) | `files:read` | `{ names: string[] }`, debounced 150 ms, one directory level, the canvas service's own watch (`canvas-service.ts:751-779`) moved to the server |

- `root` is `{ kind: 'boards' | 'workspace', workspaceId }`. The server
  resolves it itself: `boards` with `canvas-board-store.ts`, `workspace` from
  the workspace registry. `path` is relative, uses `/`, and is refused
  `invalid_params` if it holds `..`, a drive, or a NUL. The resolved real path
  must stay inside the root, symlinks included.
- In v1 `files.write` and `files.remove` accept only `*.excalidraw`. That is
  all the canvas needs. The general write lands with the file explorer.
- `hash` is the SHA-256 of the bytes, hex.
- A write over the client frame stages its bytes with `uploads.begin
  { purpose: 'file', byteLength }`, the existing upload path generalised: any
  media type, up to 64 MB when the purpose is `file`.

**The remote `CanvasFs`.** `src/main/canvas/protocol-canvas-fs.ts` implements
`CanvasFs` and the directory watcher over these methods.

- The service runs with `path.posix` and two virtual roots,
  `/boards/<workspaceId>/` and `/workspace/<workspaceId>/`, which the adapter
  maps to `root` and `path`. The service's path logic (`locate`,
  `canvas-service.ts:359-393`) is unchanged, and a Windows desktop driving a
  Linux server never mixes separators. `canvas-service.ts` takes `path` as a
  dependency, defaulting to `node:path`.
- `CanvasFs` gains one optional member, `writeFileAtomic(path, text,
  { ifMatch })`. `writeScene` (`canvas-service.ts:599-629`) uses it when
  present, instead of a temp file and a rename. The node implementation keeps
  today's sequence. The remote one is one `files.write`. On `conflict`,
  `writeScene` answers `fs_conflict`. `applyAgentWrite` and `commitScene` then
  run `settleDisk` and retry once inside the board's queue. For an agent's
  edit, that sends it back through the person-wins test (2.3). For the person's
  commit, the merge simply runs again. A second conflict in a row is reported
  as today's write failure.
- The service's temp-file sweep (`canvas-service.ts:488`) is a no-op over the
  protocol, because the server's atomic writer cleans up its own temp files.
- While the server runs in the desktop's own process (phase 5, before phase
  6's flag), the shell keeps `createNodeCanvasFs()`. They are the same files on
  the same disk, and the server's `files.write` uses the same atomic writer.
  From phase 6 on, every environment uses the protocol `CanvasFs`, the local one
  included, so the server process is the only one that touches board files.

**Live updates to every client.**

- Every client that shows a board runs a canvas service, or later an
  equivalent, for that environment. Each one follows `files.watch` on the
  board's directory.
- Desktop A runs an agent's `canvas.edit`, its service writes the file, and
  every other client's watch fires. Their services reload the board with
  `mergeFromDisk` (`canvas-service.ts:1779-1807`) and push the scene to their
  own panes over today's IPC.
- On a resubscribe after a reconnect, the adapter fires one synthetic change
  for every open board, so a change missed while away is read.
- The person's edits in desktop B are committed by B's service and written the
  same way. An agent edit running in A then sees them through `settleDisk` and
  yields under person-wins, exactly as it does for a change made by hand on
  disk today.
- **Presence across clients is not carried in v1.** The "agent is editing"
  badge shows in the client that ran the call. Another client sees the result
  when the file changes. A server-side `tools.activity` push (which conversation
  is calling which tool, with no input) can carry it later.
- `mergeFromDisk` and `repairBindingPairs` move from `canvas-service.ts` into
  `src/shared/canvas/`, so a browser client can merge without the Node service.

**What the toolset needs from the person's screen.** `canvas.open` reveals a
tab in the desktop running the call (`canvas-service.ts:1487-1521`), which is
the client the agent is routed to. That is also the client most likely to be
in front of the person (6.2).

### 10.4 Remote servers: what `localhost` means

On a WSL server, the Windows pane reaches the distribution's `localhost`
through WSL's forwarding, as today. On an SSH server, an agent that starts a
dev server on the remote and calls `browser.open http://localhost:5173` would
reach the laptop's port 5173, not the remote's. Phase 8 owns the fix (phase 8
§6.8, decisions R75 and R76): a per-environment partition
(`persist:env-<id>`) whose proxy is a SOCKS forward carried over the SSH
connection the desktop already holds, by the relay's `tcp` streams rather
than `ssh -D`, with `proxyBypassRules: '<-loopback>'`. The pane then sees the
remote's network with no port juggling and keeps its native fidelity. SSH
environments arrive with phase 8, so there is no gap to cover before it.
`browser.status` reports `network: 'remote'` or `'local'` per tab.

### 10.5 The web client

The web client runs Excalidraw in a real browser, so it can offer `canvas`
later, with the same tools over the same board files. Phase 9 does (its §3.8,
decisions R79). It cannot offer `browser`, because a page cannot drive
arbitrary sites. A server whose only attached client is a web tab therefore
lists `canvas` (from phase 9) and not `browser`.

### 10.6 Editor, tour and terminals

`editor.*`, `tour.*`, `terminal.*`, `agent.launch` and `backlog.work` act on a
person's screen or terminal too, and today reach windows by IPC brokers
(`editor-reveal-broker.ts:49,120-148`, `tour-service.ts:55-63`). They belong
in built-in toolsets offered by the shell, `editor`, `tour` and `terminal`.
For the terminal family, the toolset keeps today's wire names, so it may hold
`agent.launch` and `backlog.work`. They do not move in this phase, because
they are not in the way of a server without a screen until phase 6 moves the
gateway out of process. Phase 6 moves them onto this mechanism instead of
building bespoke `ShellBridge` members for them (phase 6 §6.3, decisions R78).
`ShellBridge` keeps only what is not an agent tool: revealing a tab for a
clicked notice or a deep link, and the terminal launches behind two internal
service tokens.

## 11. Migration

### 11.1 Commits

Each commit leaves `npm run verify:app` green. Sizes are relative.

1. `docs(studio-server)`: this spec, deleting the headless-rendering spec. (S)
2. `feat(protocol)`: `tools.ts` with the offer, frames, limits and
   validators; `kind` and `instanceId` in `hello`; the `tools:offer` and
   `files:write` scopes; the `client-tools` capability, not yet advertised.
   Validator tests: patterns, counts, sizes, schema root, `$ref`, results and
   image MIME types. (S)
3. `feat(server)`: `ClientToolRegistry`: offers per instance, name bindings
   and the reserved list, reach, routing (6.2), deadlines, the grace, orphaned
   calls, redelivery, cancellation. Unit tests against fake connections, with a
   fake clock, covering every row of 8.1. (M)
4. `feat(server)`: the RPC wiring: `tools.*` methods and the catalog topic;
   `call`, `cancel`, `reply` and `progress` on the connection; the limits in
   4.8; the RPC audit entries; `client-tools` advertised. Router tests: a
   paired app without `tools:offer` is refused, a non-shell `browser` offer is
   refused `reserved_name`, a second app is refused `name_taken`, and a revoked
   app's offers are dropped at once. (M)
5. `feat(gateway)`: `resolveTools(context)`; per-connection catalogs (5.3);
   per-socket `list_changed` with coalescing; client tools as registrations;
   origin prefixes; `notifications/cancelled` and `progress` forwarding;
   `servedBy` in the gateway audit; `expectShellToolsets` and the boot wait.
   Tests: a catalog that only grows; `client_unavailable` after a disconnect;
   one notification per burst of offers; a connection that cannot see an app's
   toolset is never notified of it. (M)
6. `feat(sdk)`: `client.tools` (offer, re-offer on reconnect, the call memory,
   `AbortSignal`, progress, `toolResult`, local size check). Tests through
   `studio-rpc.test-helper.ts` against the in-process router: a call and its
   reply; redelivery after a dropped transport answered from memory with the
   handler run once; a new `instanceId` failing a mutation; cancel aborting the
   signal. (M)
7. `feat(desktop)`: the shell client. Main attaches an SDK client over a port
   with `shell: true` and offers `browser` with `offerGatewayTools` over
   today's `createBrowserTools(...)`. `createBrowserTools` leaves `appTools`.
   `tools.focus` from window focus. Parity tests 11.2 (1)–(3). (M)
8. `refactor(canvas)`: `path` and `writeFileAtomic` as service dependencies;
   `mergeFromDisk` and `repairBindingPairs` into `src/shared/canvas/`; the
   portable list in the boundary test. No behaviour change; the canvas service
   suite passes unchanged. (S)
9. `feat(server)`: the `files` subset (10.3) with roots, confinement, the
   `.excalidraw` filter, the atomic writer, `ifMatch`, the watch topic and
   `uploads` with `purpose: 'file'`. Tests: `..`, an absolute path, a symlink
   out of the root, a non-board write refused, a conflict, create-only, a watch
   debounce. (M)
10. `feat(desktop)`: the protocol `CanvasFs` and one canvas service per
    environment; the shell offers `canvas`; `createCanvasTools` leaves
    `appTools`; `studio-core.ts:54`'s note is rewritten. Parity tests 11.2
    (4)–(6). (M)
11. `feat(settings)`: "Give agents tools from this app" in the pairing dialog;
    reach; the connected-apps list with instances and toolsets; `tools.grant`
    from a chat's menu; origin labels on tool rows and approval cards from the
    catalog topic; revocation deleting bindings and approval rules. Renderer
    tests for the labels; a store test for the rule deletion. (M)
12. `docs(sdk)`: the client-tools guide and example in `packages/agent-sdk`,
    and a `docs/compatibility.md` note that `client-tools` is a capability
    within protocol version 1. (S)

Commits 2–6 are the general mechanism and change nothing an agent sees. 7 and
10 are the two moves, each behind a one-release fallback flag,
`SPRINTENGINE_CLIENT_TOOLS=0`, which keeps today's in-process registration.
The flag is deleted in the release after.

### 11.2 Parity tests

1. **The list agents see.** A snapshot of `tools/list` (names, descriptions,
   schemas and order) from the desktop composition is taken in commit 7 before
   the move, for a `studio-agent`, an `external-local` and a `remote-tailnet`
   connection with a device gate. It must stay byte-identical after commits 7
   and 10.
2. **Through the loop.** The `browser-tools.test.ts` cases run twice: the
   handler called directly, and the same `tools/call` sent to the gateway
   socket, routed by the registry to the shell client over a port, and handled
   by the same fakes. Results must be deep-equal, image bytes included, and
   errors (`pane_unavailable`, `no_tab`, `interrupted`) identical.
3. **Boot.** An agent connecting while the app starts lists the browser and
   canvas tools on its first `tools/list`.
4. **The canvas service on both filesystems.** `canvas-service.test.ts` runs
   against the in-memory `CanvasFs` (today), against `createNodeCanvasFs` on a
   temp directory, and against the protocol `CanvasFs` over an in-process
   server with a temp data directory. Every case passes on all three.
5. **Two clients, one board.** Two canvas services over the protocol on one
   board: an agent edit in one while the other commits a person's edit to the
   same element ends `interrupted` with the person's version on disk; edits to
   different elements both survive; each service's subscribers receive the
   other's change within the watch debounce plus one round trip.
6. **Canvas through the loop**, as (2), for the eight canvas tools with the
   worker transport faked.
7. **Cancellation.** Interrupting a turn while a client tool runs answers the
   agent `cancelled` and aborts the handler's signal.

## 12. What this removes from the old phase 5

The parent and the decisions file can drop all of the following. None of it is
built.

- **The render host**: `RenderHost`, `RenderBackend`, `RenderLease`,
  `RenderPage`, the CDP-over-pipe client (`src/server/render/cdp.ts`), the
  `devtools-protocol` dev dependency, and the `electron-child` backend with its
  `--sprintengine-render-host` mode in `app-main.ts` and its stdin control
  channel.
- **The Chromium download**: the source chain (owner path, system browsers,
  the pinned Chrome for Testing archive), the pin manifest and
  `scripts/pin-chromium.mjs`, our own SHA-256 pins, the staging, verify, unzip
  and `flock` install, pruning, "who downloads" (D10), the stale-pin warning,
  and the licensing section on Chrome for Testing.
- **The host probe and the sandbox**: `ldd` library mapping to apt and dnf,
  the glibc and musl checks, the sandbox cause classifier, the AppArmor profile
  and its root command, `render.allowNoSandbox` (D5), the container and host
  CI matrix.
- **Pools and lifecycle**: one Chromium per workspace profile, the pool cap of
  4, LRU parking, tab parking and `tabs.json`, idle timers, the memory
  ceiling, crash loops.
- **Fonts on the server**: `--font-render-hinting=none`, the offline canvas
  process with its resolver map and `Fetch`-served origin, Xiaolai and emoji
  bundling for a server worker (D6 and D7 as server questions).
- **The CDP canvas transport** and the `export-svg` worker operation.
- **The agents' browser on the server**: `BrowserTabsService`, the
  `CdpSession` seam under `browser-control.ts`, server-owned popups, dialogs,
  file choosers, downloads, HTTP auth, the navigation and origin deny-list,
  UA overrides and the downloads and uploads directories under `render/`.
- **The screencast**: `browser.screencast` with binary frames, binary support
  in `websocket-frames.ts`, fan-out and the latest-frame slot,
  `ScreencastView`, `browser.input`, picker overlays, the clipboard bridge,
  IME mapping, cursor and focus emulation, the Console and Network drawer, the
  `Overlay` element picker, and the `browserPane.mode` setting.
- **Protocol surface**: the `canvas` namespace (`list`, `open`, `board`,
  `commitScene`, `exportImage`), the `browser` namespace, the scopes
  `canvas:read|operate` and `browser:read|operate`, and the welcome
  capabilities `render-host`, `canvas-render`, `browser-headless`,
  `browser-screencast` and `render-download-pending`.
- **The parent's §8.4 fallback**, which routed canvas work to an attached
  client. That is now the only path, and it is a general one.

**What survives**, outside this phase:

- D11, a `browser.dialog` tool and a `dialog_open` error. A JavaScript dialog
  in the native pane can stall an agent today. It is a desktop browser-tool
  change.
- D6, as a desktop question. The worker and the pane fetch Xiaolai from esm.sh
  for CJK text today. Bundling it stops a network fetch from the app.
- Previews and HTML artifacts need nothing (old §2.3). They are client
  renderings of server data.
- The experiments' facts about Chromium and the Node canvas, which section 14
  keeps for the headless client.

## 13. Changes the parent and phases 6–9 need

All of these are made in the same change as this spec.

| Where | Change |
| --- | --- |
| Parent §1 | "The server owns … the MCP gateway and its tools, the canvas board store" → the gateway and tool routing; board files on its disk. Ruling (e) is replaced by the 2026-10-02 ruling (1.1). |
| Parent §2, goal 6 | Withdrawn for v1: agents draw and browse through an attached client; the headless client (section 14) restores it later. |
| Parent §5.1 | The `call` and `reply` sketch becomes 4.4's `call`, `cancel`, `reply` and `progress`. |
| Parent §5.2 | Delete the `canvas` and `browser` rows. Add `tools` (phase 5) and the `files` write and watch subset (phase 5, owner only). |
| Parent §5.3 | Welcome capabilities: drop `canvas`, `render-host`, `browser-headless`; add `client-tools`. `hello.client` gains `kind` and `instanceId`. |
| Parent §6.3 and §6.4 | Rewritten as client toolsets: built-in `browser` and `canvas` now; `editor`, `tour`, `terminal` in phase 6. `notify`, `reveal-tab` and `cipher` stay client capabilities. |
| Parent §6.7 | "Canvas on the server" becomes "Canvas is a client toolset": boards are files on the server, the service and the worker run in the client (10.2, 10.3). |
| Parent §8 | Delete "The render host" whole. Point to this spec's section 14. |
| Parent §9.4 | The tailnet scope families lose `canvas:read|operate`. `tools:offer` is never granted to a tailnet pairing in v1. |
| Parent §13, phase 5 | "The render host (L)" → "Client tools (M)", scope as 1.2, tests as 11.2. |
| Parent §14, §15 | Drop the Chromium download, sandbox and font risks and questions. Add the runtime-coverage risk (section 15 here). |
| Phase 6 | `ShellBridge.browserPane` (CDP over the control channel) and `ShellBridge.canvasRender` are replaced by the shell's `browser` and `canvas` toolsets, offered over the control channel. The server carries no CDP. `editor`, `tour` and `terminal` move to toolsets too (10.6, R78); `reveal` stays on `ShellBridge`, because it serves a clicked notice, not an agent. D5 and O5 ("the shell's offscreen worker and pane over ShellBridge") are met by this spec. The canvas service leaves the server-owned list (phase 6 §5); the board files stay server-owned. |
| Phase 7 | §3.8 "Render host" is deleted. A WSL server lists the Windows desktop's toolsets like a local one. "The attached desktop renders for WSL" is now the only path, for canvas and browser alike. No Linux Chromium. |
| Phase 8 | §6.8 "The headless browser on the remote" is replaced by the pane's traffic through the SSH connection: the proxied per-environment partition (10.4) so `browser.*` reaches the remote's `localhost`. |
| Phase 9 | Remove the screencast pane and `browser-pane-screencast`. The web client offers no `browser` toolset in v1; where the desktop shows a browser tab it shows a preview of a dev server on the server, on an origin of its own (phase 9 §3.6), with "Open in the desktop app" when a desktop is attached. It offers `canvas` (10.5, phase 9 §3.8), so the canvas worker row (`canvasWorker/transport.ts:40`, "server-side, render host") becomes "loaded by the web client to offer `canvas`; never server-side". |
| Decisions | Rows R37, R38, R40–R43, R45–R47, R49 and R50, and "The browser pane and the render host", are superseded. The tab model, screencast and render-host answers no longer apply: tabs live in the desktop's pane, and only clients render. This spec's open decisions are rows R80–R86. |

## 14. Later: the headless client (out of scope)

Not in this phase. Recorded here so the research is not lost.

A small separate program, run next to the server, that connects as an
ordinary client and offers `browser` and `canvas`, so agents keep both tools
when no desktop is attached. It holds the owner credential of its host
(`<dataDir>/run/owner-token`) and says `kind: 'headless'`, so it may offer the
built-ins (7.2), and routing prefers any desktop over it (6.2). It is shipped
beside the standalone server, never inside it, so the server stays small, and
it is started by the person or by `studio-server service install` when they
want unattended tools.

**`canvas` in plain Node** (research of 2026-10-02, two independent runs):

- Excalidraw 0.18.1 exports `setCustomTextMetricsProvider`
  (`dist/types/excalidraw/index.d.ts:45`) for exactly this. With jsdom for the
  DOM and `@napi-rs/canvas` (Skia) for every `<canvas>`, the app's own
  `convertToExcalidrawElements`, `exportToSvg` and `exportToCanvas` ran
  unmodified.
- Label widths matched headless Chrome within 0.0063 px, and "calls" in
  Excalifont 20 px came out at 41.46, the Electron worker's value. Bundled
  fonts are required: system Helvetica differed by up to 1.5 px.
- A PNG export took 7 ms, and the module imports in about 100 ms.
- Cost: a prebuilt native binary of 27–38 MB per platform, statically linking
  Skia, with no system libraries, no sandbox and no download. A musl build
  exists.
- Shims needed: `document.fonts`, a `FontFace` stub, and
  `document.createElement('canvas')` returning a napi canvas. One run that
  skipped the canvas shim exported PNGs with no text or arrows, so golden-image
  tests against the Electron worker's output are required.
- Gaps: **mermaid import needs a real layout engine** (jsdom has no `getBBox`).
  The headless client answers it with "diagram import needs Studio on a
  desktop". CJK in Xiaolai ships as 209 subsets and needs codepoint-to-subset
  routing (about 50 lines). Image elements need napi's `Image` mapped in,
  untested. `exportToBlob` is replaced by `exportToCanvas` and `encode()`.
- It runs the same `canvas-service.ts` and `canvas-tools.ts` as the desktop
  over the protocol `CanvasFs` (10.3), with a Node `CanvasWorkerTransport` in a
  `worker_threads` worker in place of the hidden window.

**`browser` with headless Chromium:**

- `chrome-headless-shell` from Chrome for Testing (99–121 MB per platform;
  linux-arm64 exists from 153), driven over `--remote-debugging-pipe`, with
  `browser-control.ts` behind a `CdpSession` seam. Electron's `Target.createTarget`
  is not supported, so this path is plain Chromium only.
- One process and one persistent profile per client, not one per workspace.
- On Ubuntu 23.10+ a downloaded binary cannot start its sandbox without a
  root-installed AppArmor profile, and Debian slim lacks about 20 libraries.
  A system Google Chrome under `/opt/google/chrome`, or Debian's
  `chromium-headless-shell` package, avoids the AppArmor problem. Never run
  without the sandbox silently.
- Showing the person what it does (screenshots in the transcript, or a
  screencast) is that client's business, not the server's.

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| Agents on Codex, Cursor or Grok do not pick up a client that attaches mid-session | stable lists (5.3); the tools appear at the next session; "client_unavailable" names the fix. Their chats are not handed the gateway today (finding 2, open decision 7); their terminal sessions are. |
| Claude Code's ToolSearch index does not refresh after `list_changed` (anthropics/claude-code#66084) | additions only, never removals; an integration test in the Claude provider suite that a tool added mid-session can be called, run on each CLI bump |
| An agent's browser work stops when the laptop sleeps | intended under the ruling; the 20 s grace covers blips; the message says to reconnect a desktop; the headless client later |
| A slow client stalls an agent | per-tool deadlines (4.5), `busy` limits (4.8), cancellation on interrupt (8.4) |
| A mutation runs twice after a reconnect | the SDK's call memory and the `instanceId` rule (8.3): at most once per mutation |
| Two desktops edit one board | `ifMatch` writes, `settleDisk`, person-wins (10.3); test 11.2 (5) |
| A malicious or careless app feeds agents misleading tools | `tools:offer` off by default, reach "own" by default, origin prefixes and labels, rules deleted with the app, audit (section 7) |
| Workspace id collisions across environments in the pane | tabs keyed by environment and workspace (10.1) |
| Remote `localhost` from an SSH chat reaches the laptop | phase 8's proxied partition (10.4), which ships with SSH environments; `browser.status` says per tab whose network it uses |

## 16. Open decisions

These are rows R80–R86 of `decisions.md`, in this order (spec IDs `P5c-1` to
`P5c-7`). Decisions 3 and 7 are for the owner; the rest are settled there.

**1. Where boards live.**

- (a) Where they are: the server's data directory, `canvas/ws_<hash>/`, plus
  the legacy `diagrams/` folder.
- (b) In the workspace, for example `.sprintengine/boards/`, so they are
  versioned and shared with the repository.

*Recommendation:* (a) for this phase. It moves nobody's files, keeps
agent-drawn scratch boards out of commits, and needs no migration on any host.
(b) is a separate product question about whether boards are project content.
`canvas.open` with a folder path already puts a board in the workspace when an
agent or person wants that.

**2. Routing among several desktops: focus first, or the starter first?**

*Recommendation:* the order in 6.2: affinity, then the window the person is
looking at, then the one showing the workspace, then the starter. The person
watching is the person who can see and take over the browser. Affinity keeps a
conversation from hopping once it has started.

**3. Approve each app toolset on first offer, beyond the `tools:offer` scope?**

- (a) The scope given at pairing is the consent, plus Settings visibility and
  the audit.
- (b) A Settings prompt the first time an app offers a toolset name, and again
  when a toolset gains a tool.

*Recommendation:* (a), with an OS notification "Acme Game gave agents 2 tools"
on the first offer of each name. The app already runs as the person, the reach
defaults to its own conversations, and each call still passes the agent's
approval. (b) adds a prompt that guards against nothing the pairing did not
already allow.

**4. Should the server answer `canvas.list`, `describe` and `find` itself when
no client is attached?** They only read JSON.

*Recommendation:* no, not in v1. It would split the canvas family across two
owners with different lists, and the ruling keeps the canvas off the server.
An agent with no client can still read board files with its own file tools when
they live in the workspace.

**5. Remove a client's tools mid-connection for runtimes that handle it?**

*Recommendation:* no (5.3). Removal only helps Claude Code and OpenCode. It
breaks prompt caching and the ToolSearch index, and it makes those
runtimes behave differently from the rest for no gain over a clear
`client_unavailable`.

**6. The grace and default timeout values** (20 s grace, 60 s default, 600 s
maximum).

*Recommendation:* ship these and log the distribution of reconnect gaps and
call durations, then revisit after a release.

**7. Give Codex and ACP chats the gateway at launch?** Today only Claude chats
are handed it (finding 2), so only they and terminal agents reliably have the
browser, canvas or app tools. A Codex or ACP chat reaches the gateway only by
chance, from an entry a terminal launch pinned into the workspace, and an ACP
chat's connection then carries no identity, so it never sees an app's
conversation-scoped toolset.

*Recommendation:* yes, in a separate change after this phase. Pass the gateway
in `codexMcpServerArgs` (`codex-conversation-provider.ts:1369`) and in ACP's
`newSession`/`loadSession` `mcpServers` (`acp-conversation-provider.ts:907-921`),
with the chat's identity on the entry itself (as `withAgentIdentity` does for
Claude), since the ACP child's environment drops `SPRINTENGINE_*`. Keep one
copy: a pinned workspace entry the CLI would also load is the same server
twice, which the terminal path already avoids for Claude
(`studioGatewayDeliveredAtLaunch`). The stable list (5.3) already makes it
safe for runtimes that ignore `list_changed`.
