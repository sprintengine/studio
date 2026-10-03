# Phase 7 — the Studio server inside a WSL distribution

Status: scoped, 2026-10-01. Nothing here is implemented. This file hardens
phase 7 of `docs/design/studio-server.md` (sections 10.2 and 13) and assumes
phases 1–6 have landed: an Electron-free core (`createStudioCore`), the Studio
protocol and `@sprintengine/agent-sdk`, and a Windows-side local server running
out of process. Where this file disagrees with the parent design, section 12
lists the change the parent needs.

Amended 2026-10-02 for the owner ruling of that date: the server has no
browser and no canvas. A WSL server renders nothing and downloads no Chromium;
its agents get `browser` and `canvas` from the Windows desktop, through the
front door, as phase 5's client toolsets (`phase-5-client-tools.md`).

It was written on a Mac with no WSL. Everything said about WSL's behaviour
comes from reading the code that drives it today and from WSL's documented
behaviour, not from running it. Statements that need a real Windows machine to
confirm are marked **(unverified)**, and section 9.4 collects them into the
checklist the phase must pass before its default changes.

## 1. Summary

- On Windows, each WSL distribution that has a workspace in use gets its own
  Studio server. It runs the server bundle on the pinned Linux Node that Studio
  already installs, from the same install pipeline as the helper, under
  `~/.local/share/sprintengine-studio/`.
- **Agents, git and files for that workspace are native Linux.** Agents are
  plain children of the server. Git is the distribution's git, run locally. Paths
  are Linux paths from end to end. The per-spawn `wsl.exe` launch
  (`cli-host-child.ts`), the base64 `eval` wrapper, the fd 57/58 parking, the
  outbound path respelling and the inbound respelling (`approvalCheckInput`,
  ACP `fs` callbacks, Codex saved images) all stop being used for chats.
- The **Windows-side core is the front door**. It starts and supervises the WSL
  servers and routes every conversation operation for a WSL workspace to that
  workspace's server, through one `ConversationBackend` seam (section 5). The
  renderer, the phone lane, the MCP gateway, module conversation services and
  scheduled agents all keep calling what they call today, and WSL chats keep
  working for all of them.
- **Transport**: loopback TCP inside the VM (`127.0.0.1`, an ephemeral port),
  reached from Windows over WSL2 localhost forwarding. The handshake
  authenticates **both** ends. When the probe fails, the fallback is a **stdio
  bridge**: one `wsl.exe` whose stdio is spliced byte for byte onto the server's
  owner socket. It always works, so a `.wslconfig` cannot break chat.
- **Which server owns a workspace** is decided by the workspace's machine
  (`hostId`), never by where the folder sits. A `C:\` folder bound to a WSL
  machine runs its agents and git in WSL over `/mnt/c`, as it does today. File
  reads made for the UI (mention search, stat, image previews) stay on the
  Windows side, where NTFS is fast. Section 6 explains why.
- **The per-process path stays**, behind a per-distribution switch, as the
  fallback and the migration route. It is removed for chats only after a
  release with the server on by default. The helper stays for terminals, the
  Git pane and the file explorer until phase 10.

## 2. What exists today (the machinery this phase builds on)

| Piece | File | What it does now | In phase 7 |
| --- | --- | --- | --- |
| Pinned Node | `hosts/wsl-node-runtime.ts` | `v24.21.0`, four SHA-256 sums (x64/arm64 × xz/gz), downloaded and verified on Windows, glibc floor 2.28 | Reused unchanged as the server's runtime |
| Install | `hosts/wsl-install.ts`, `wsl-helper-runtime.ts` | Launch script reports `@@SPRINTENGINE_NEED`. Archives are streamed over `wsl.exe` stdin into `tar` in a private stage, then committed under `flock` with a digest marker and `mv -T`. Pruning skips any tree a live process names in `/proc/*/cmdline` | Gains a `server` tree and a launch-script `entry` (3.2) |
| Helper | `resources/wsl-helper/*`, `hosts/wsl-helper-client.ts` | NDJSON over one `wsl.exe` stdio: `boot` then `hello`, process probes, CLI detection, `run`, `git`, watches, launch files, agent-state and MCP relay with per-launch channel tokens. Idles out 120 s after its last session. Restarts with backoff and a fatal hold | Stays, for terminals, the Git pane, watches and the file explorer. No chat uses it |
| Distro access | `hosts/wsl-distro.ts` | `-d <distro>` always. Scripts go on stdin (`--exec sh -s`), runs start with `--cd ~`, output is decoded as UTF-16LE or UTF-8, the list and default are cached | Reused for every `wsl.exe` the server path starts |
| Host | `hosts/wsl-host.ts`, `host-registry.ts` | One `ExecutionHost` per distro, `toHostPath`/`toNativePath`, `runGit` through the helper, `nativeGitOutput` respelling | Unchanged for the shell's own uses |
| Chat child | `providers/cli-host-child.ts`, `claude-wsl-child.ts` | `wsl.exe … bash -c 'set -f;IFS=;eval $(echo <b64>|base64 -d)'` through a login `bash -lic`, with stdio parked on fds 57/58 while the profile runs | Fallback path only (section 7) |
| Paths | `shared/host-paths.ts` | `toWslPath`, `wslToWindowsPath`, `comparablePath`, `wslPathInRootSpelling`, `wslInputInRootSpelling` | Used only at the edge (5.6), plus the fallback |
| Git routing | `git-run.ts` (`installGitHostResolver`, `withGitHost`), `app-services.ts` `findWorkspaceHostForPath` | A folder inside a distro, or a `C:\` folder of a WSL workspace, runs git through the helper. Checkpoints follow, because they use `runGitCommand` | On the server, git is local. The shell keeps the resolver for the Git pane |
| Approvals | `conversation-runtime.ts` `approvalCheckInput` | For a session whose CLI `hostId` is WSL, respells Linux paths into the root's Windows spelling | Must become a no-op on the server (4.10) |

Three facts from that reading shape this phase:

1. **Chat state for a WSL workspace already lives in two places.**
   Transcripts, tool details and the thread index sit in the workspace's
   `.sprintengine/` sidecar, which Windows main writes today through
   `\\wsl.localhost\…` (or natively under `C:\…`). Attachments
   (`conversation-attachments/`), plans (`conversation-plans/`) and approval
   rules (`conversation-approval-rules.json`) sit in the Windows userData, keyed
   on the **workspace root as Windows spells it**: a SHA-256 of
   `workspaceRoot\0workspaceId\0agentId`, and a plain string compare for
   approval rules. A server that reports `/home/dev/repo` computes different
   keys, so migration has to re-key them (7.3).
2. **Many in-process consumers call `ConversationRuntime` directly, not through
   `ConversationSessionApi`**: `companion-agent-service.ts`,
   `module-host/module-conversation-service.ts`,
   `automation/tailnet/tailnet-conversation-host.ts`,
   `modules/scheduled-agents-module.ts`, `modules/agent-runtime-module.ts`,
   `ipc/conversation-ipc.ts`. If WSL chats moved out without a seam under all
   of them, the phone, scheduled agents and gateway tools would lose WSL chats
   that work today. Section 5 is that seam.
3. **WSL chats had no Studio gateway.** A launch's MCP channel token was
   issued only for WSL *terminal* launches (`terminal-runtime.ts`,
   `issueChannelToken`), so the helper's relay dropped a chat agent's channel.
   This is **fixed on `main`** (#133 and its follow-ups): a WSL chat is issued
   a channel token per session, an ACP agent keeps its own, and the token is
   taken back when a start is refused. Phase 7 makes the token unnecessary for
   chats: a chat agent in WSL reaches the server's own owner-only socket.

## 3. Spec

### 3.1 Inside the distribution

```
~/.local/share/sprintengine-studio/
  runtime/node-v24.21.0/bin/node          pinned Node (existing)
  <appVersion>/wsl-helper/ hooks/ automation/ plugin/   helper payload (existing)
  <appVersion>/server/                    NEW: server.mjs, bridge.mjs, resources/, rg
  data/                                   NEW: the server's data dir (default profile)
  data-<profileId>/                       NEW: any other Windows profile's data dir (D3)
    run/  studio.lock  server.json  owner-token  data.key  studio.sock  automation.sock
~/.local/state/sprintengine-studio/logs/  server-*.log
```

- The prune glob in `buildCommitScript` is `"$base"/[0-9]*` for app trees and
  `runtime/node-*` for Node, so `data*/` is never pruned. A test pins that, so
  a future glob change cannot delete a person's chats.
- One server per data directory, enforced by `flock` on `run/studio.lock`,
  which is held for the process's lifetime.
- **Socket paths must stay under about 100 bytes.** With a long `$HOME` or an
  `XDG_DATA_HOME` override, the owner socket and `automation.sock` move to
  `$XDG_RUNTIME_DIR/sprintengine/<profile>/`, or to
  `/tmp/sprintengine-<uid>/<profile>/`. The checks are those already in
  `resources/wsl-helper/lib/sockets.mjs` (`ownedPrivateDir`: a real directory,
  owned by this user, mode `& 077 == 0`, and the bind-to-temp-then-rename
  dance). `server.json` names where they ended up. That code is shared, not
  copied.
- The helper and the server are separate processes in phase 7. The helper is
  version-locked to the app over a private wire. The server speaks the
  versioned Studio protocol. Folding the helper into the server is phase 10
  work (D8).

### 3.2 Install

- The server tree is installed exactly like the helper payload: stage, `tar`
  over stdin, commit under `flock` with a digest marker and `mv -T`, and prune
  what nothing runs from. It is a **separate tree with its own marker**
  (`<appVersion>/server/.ready`). A person who uses WSL only for terminals
  never uploads it, and a server-only change does not reinstall the helper.
- `buildLaunchScript` gains an `entry` (`helper | server`). The server entry
  checks the Node marker and the server marker. It then `exec`s
  `setsid "$rt/bin/node" "$app/server/server.mjs" --stdio-lease`, so the
  existing `NEED` / install / retry loop in `wsl-helper-client.ts` drives both.
  That loop's start half is extracted as `startWslEntry(...)`, which keeps the
  prewarm, backoff, fatal hold and `classifyWslFailure`.
- **Archive size.** The bundle includes the Linux ripgrep binary, and later
  the web client. It carries no canvas worker and no browser: nothing renders
  in the distribution. It is streamed once per app
  version per distro over `wsl.exe` stdin. The 10-minute tar deadline is kept.
  The digest is computed over a deterministic tar (`buildAppPayload`), so a
  reinstall happens only when a byte changes.
- The commit check for the server tree runs
  `"$rt/bin/node" "$stage/server/server.mjs" --version` and requires this
  build's version. A bundle that cannot load on this distro (for example, a
  missing optional library) fails here with the reason, not on first chat.

### 3.3 Bootstrap sequence

Run by the Windows-side `WslEnvironmentManager` (section 5.2), per distro, on
demand:

1. **Resolve the distro.** The workspace's `hostId` gives `wsl:<distro>`. The
   name is checked by `isValidWslDistroName`. `wsl --list --verbose` (cached)
   gives the state and the WSL version. A distro reported as version 1 takes
   the per-process path (D2).
2. **Start.** Run `wsl.exe -d <distro> --cd ~ --exec sh -s` with the server
   launch script on stdin. If the script prints `NEED`, install (3.2) and retry,
   with the helper's prewarm and backoff.
3. **Wait for `boot`.** The server prints `{"boot":{protocol,pid,version}}`
   before reading anything. This is the same guard as the helper, so the `sh`
   that exec'd it cannot have swallowed part of the envelope.
4. **Send the envelope.** Write one JSON line on stdin:
   `{ dataDir?, profile, listeners: { owner: true, loopback: true, tailnet: false }, ownerToken, appVersion, buildStamp, windows: { distro, driveMountRoot? } }`.
   It is never put in argv or the environment, because `wsl.exe` command lines
   are visible to Windows process listings and in Linux `/proc/<pid>/cmdline`.
   `tailnet: false` is mandatory (4.4).
5. **Wait for `ready`.** The server writes
   `{"ready":{port,socket,environmentId,version,uid,user,home,driveMountRoot}}`
   once its listeners are bound, and writes `run/server.json` (0600). The
   ready budget is 45 s on a cold VM, the helper's `DEFAULT_BOOT_TIMEOUT_MS`.
   On a miss, the manager kills the starter and reports the log tail
   (`wsl.exe --exec tail` on the server log).
6. **Keep stdin open as the lease.** After the envelope, the starter's stdin
   stays open and carries only heartbeats (`{"t":"lease"}` every 15 s). Its
   EOF means "the Windows side is gone" (4.6).
7. **Choose the transport.** See 3.4.
8. **Handshake.** Send `hello` and verify the server's proof (4.2), then
   `welcome`. Check `environment.id` against the one recorded for this route.
   A different id means a different data dir, for example after a default-user
   change (8.6), and the manager says so instead of silently showing an empty
   chat list.
9. **Adopt workspaces.** Call `workspaces.ensure` (owner only, idempotent)
   for each WSL workspace on this distro the front door is about to route:
   `{ id, root: <Linux spelling>, name }`. The WSL server's registry is a mirror
   of what it has been asked to serve, not the person's list (5.4).
10. **Route.** The front door's `RoutedConversationBackend` starts sending
    this distro's conversation calls to the server.

A restart after a crash runs steps 2–8 again and resumes subscriptions from
their cursors. A start that fails before `ready` with a fatal code (`node-run`,
`unsupported-arch`, `distro-missing`, `wsl-missing`) is not retried in a loop.
It leaves the environment in `unavailable` with the reason.

### 3.4 Transports

**Loopback TCP (primary, per ruling d).**

- The server binds `127.0.0.1:0`, never `0.0.0.0`, never `::`, and never the
  name `localhost` (which Node can resolve to `::1` first). The Windows side
  connects to the literal `127.0.0.1:<port>`. A bind guard
  (`isLoopbackAddress`, from `tailnet-interface.ts`) refuses anything else,
  before `listen`.
- In NAT mode, the forwarded listener on Windows can appear a moment after
  the Linux `listen` **(unverified: the size of the delay)**. The probe
  retries connect for up to 3 s with short backoff before it falls back.
- Forwarding of a listener bound only to Linux `127.0.0.1` (not `0.0.0.0`) is
  documented for NAT mode with `localhostForwarding=true`, and is the normal
  case in mirrored mode **(unverified on current WSL builds; item V1)**.
- On `EADDRINUSE` from the ephemeral bind (possible in mirrored mode, where the
  port space is shared with Windows), the server retries a fresh `:0` up to
  five times.

**Stdio bridge (fallback, always available).**

- `wsl.exe -d <distro> --cd ~ --exec sh -s`, with a script that `exec`s
  `"$rt/bin/node" "$app/server/bridge.mjs"` and passes it the owner socket
  path on its first stdin line. The bridge connects to the owner Unix socket
  and splices bytes in both directions. It does no framing and holds no
  credentials.
- Because the owner socket speaks the whole HTTP and WebSocket surface (12.2),
  uploads, signed image URLs and the WebSocket all work over the bridge
  unchanged. The Node client speaks HTTP over the duplex through
  `http.request({ createConnection })`.
- One bridge carries one connection. The front door keeps one owner connection
  per WSL server, so there is one bridge per distro, not one per window.
- Throughput through `wsl.exe` stdio is lower than loopback TCP
  **(unverified: numbers)**, but the helper already moves 64 MiB frames over
  it.

**Selection.** Probe TCP on every server start. Use the bridge when the probe
fails, when the handshake proof fails (a port squatter, 4.2), or when the
person forces it (`ExecutionHostSettings.serverTransport: 'auto' | 'stdio'`).
The choice and its reason go in `server.info` and in Settings.

**Renderers.** With the front door routing (section 5), renderers in phase 7
talk only to the local server. A desktop or web client that later connects to a
WSL server directly (phase 8 and later) uses TCP with a ticket. Over the bridge,
main hands the renderer a `MessagePort` bridged to its owner connection.
`@sprintengine/agent-sdk` therefore needs a transport interface (WebSocket URL,
Unix socket, `MessagePort`, arbitrary duplex), not a URL only (12.3).

### 3.5 Lifetime

- **While a lease is held**, the server stays up.
- **The front door holds a lease while it needs the server**: a window shows a
  workspace on that distro, a turn is running there, a subscription is open,
  or background mode is on.
- **When none of that has been true for 10 minutes**, it drops the lease. The
  server then exits once no client is attached and no agent is running, which
  lets the VM idle. This is the same reason the helper idles out after 120 s.
  The cost of starting again is a cold distro boot plus a Node start: a few
  seconds, shown as "Starting WSL: Ubuntu…" on the first send.
- **Distro idle shutdown.** WSL stops an instance some seconds after its last
  `wsl.exe` session ends, and stops the VM after `vmIdleTimeout` (default
  60 s). Whether a `setsid` background process alone keeps the instance alive
  is **unverified (V2)**, and documented behaviour suggests it does not. The
  design does not rely on it. The lease *is* a live `wsl.exe` session, so the
  instance lives exactly as long as the front door wants it to.
- **App quit.** The front door calls `server.shutdown { drain: true, budgetMs:
  10_000 }`. Turns in flight finish or are suspended (stateful providers keep
  their resume cursors), then the lease drops. It does not wait longer: once
  the last `wsl.exe` is gone, the instance may stop whatever the drain is
  doing.
- **App crash.** The lease EOFs. The server keeps serving attached clients and
  running agents for a grace period, then exits. WSL may stop the instance
  sooner (V2). Either way, the next start resumes from cursors, and a turn cut
  off shows as interrupted.
- **`wsl --shutdown` or `wsl --terminate <distro>` mid-chat.** Every Linux
  process dies at once, with no signal handler run. The front door sees the
  transport close and the starter exit together.
  - It re-reads `wsl --list` with force. If the distro is `Stopped`, it treats
    this as **deliberate**: the environment shows "WSL was shut down", the
    running turn shows interrupted, and **nothing restarts the VM until the
    person acts** (a send, opening the chat, Reconnect). Restarting a VM the
    person has just stopped would undo what they did.
  - If the distro is still `Running`, it treats it as a crash and restarts with
    backoff.
  - Durability is the event log's existing rule: an event is published only
    after it is on disk. A torn last line is skipped on read (covered by a
    test).
- **Sleep and hibernate.** The VM pauses. Connections usually survive. A
  missed heartbeat reconnects from the cursor. WSL2's clock can drift after a
  resume, so **every expiring credential (tickets, pairing codes) is minted
  and checked on the same side** (the server), and nothing compares a Windows
  timestamp with a Linux one.

### 3.6 Files, watching, attachments, clipboard

- **Inside the distro (`/home/…`).** Watches are inotify, native and cheap.
  This replaces the helper-relayed watch for chat purposes (changed files).
  Boards do not move in phase 7 (3.8), so the canvas watch is not one of
  them.
- **On `/mnt/<drive>`.** WSL2's drive mount does not deliver inotify events for
  changes made by Windows processes. That is documented, long-standing WSL2
  behaviour. A server watching `/mnt/c/…` hears agent edits made in Linux but
  not the person's edits in a Windows editor. Two mechanisms cover it:
  - **Hints from the Windows side.** The front door watches the Windows folder
    natively and sends `workspaces.touch { id, paths? }` to the server. This
    works because the front door is on Windows and is always attached when a
    window shows the workspace.
  - **A slow poll** (git index mtime and HEAD every 5 s) while no front door is
    attached.
- **Attachments always cross as bytes, never as paths.**
  - A pasted image or a file dropped from Explorer (`getPathForFile` gives
    `C:\…`) is uploaded over HTTP to the server, through either transport.
  - The one exception is a file inside the workspace, such as an @-mention or a
    drag from the file tree. It is sent as a workspace-relative path, translated
    at the edge (5.6).
  - The server never reads `/mnt/c/Users/…` on the strength of a path the
    client sent. Automount may be off, and the client's path is not authority
    over the server's file system.
- **Images the agent made** (a picture Codex saved, a screenshot) come back by
  the server's signed URL. `wslToWindowsPath(savedPath)` in
  `codex-conversation-provider.ts` is fallback-only.
- **Clipboard** is shell-only, as everywhere. Copying a path from a transcript
  copies the Linux path the agent used. "Copy as Windows path" is a second
  item that uses the edge translator.

### 3.7 Agents, MCP and hooks in the distro

- Providers spawn the CLI directly (`cliSpawnTarget` with `platform: 'linux'`),
  in the workspace's Linux root, with the **login environment the helper
  already knows how to capture** (`lib/login-env.mjs`: `bash -l -i -c`, then
  `-l -c`, allow-listed variables, an 8 s deadline, a process-group kill). The
  server captures it once at start and on `pathsChanged`.
- Today every spawn runs a fresh `bash -lic`. On the server a slow profile is
  paid once, not per chat. A hung profile falls back to the server's own
  environment with a default PATH, exactly as the helper does, and the chat
  surface shows "your login profile took longer than 8 s".
- Variables a runtime strips today (`unsetEnv`, for example the OpenAI keys for
  Codex) are stripped from the child's environment here too. That rule moves
  from `wslCliLaunchArgs` into the provider's own spawn env.
- **Gateway.** Chat agents get an MCP entry naming the server's own bridge
  (`<app>/server/resources/automation/mcp-stdio-bridge.mjs` on the pinned
  Node). The entry sets `SPRINTENGINE_USER_DATA_DIR=<dataDir>`, so the bridge
  finds the server's `automation.sock` (0600, in an 0700 directory) through
  its discovery file. No channel token is needed: the file mode is the boundary,
  as it is on macOS.
  - Tools the WSL server does not own (`browser.*` and `canvas.*`, which the
    desktop offers; `terminal.*`, `agent.launch`, `backlog.*`, `editor.*`,
    `tour.*`; and module tools still wired on the Windows side) are
    **forwarded** to the front door as client tool calls (parent 6.3, phase
    5). The front door is an owner client of the WSL server with
    `kind: 'desktop'`, so it holds the shell role there (phase 5, 7.2). It
    offers, with `tools.offer`, the toolsets it can serve: those its own shell
    offers it, and the Windows-side tools. Each `call` it receives is relayed
    into its own client-tool registry or gateway, and the `reply` comes back
    the same way.
  - With no front door attached, these tools are absent from a new
    connection's `tools/list`; one already shown them keeps them listed, and
    they answer `client_unavailable` (phase 5, 5.3).
  - The result: a chat agent in WSL sees the same tool set it would see on
    Windows.
- **Hooks and agent state.** The server builds the Claude plugin copy and hook
  commands natively (`agent-integration-home.ts` on Linux). They report to the
  server's own agent-state socket. `wsl-plugin-copy.ts` and the helper's
  `agentState` relay are not used for chats.
- **Terminal agents in WSL do not change in phase 7.** They keep the helper's
  relay to the Windows gateway, and the Windows gateway's conversation tools
  reach WSL chats through the router (5.3). The distro's
  `~/.sprintengine/bin/current` pointer keeps its one writer, the Windows side
  (`wsl-host.ts` `ensureLauncher`). The WSL server never writes it in phase 7.
  Two writers of one pointer would flap it on every start.

### 3.8 Browser and canvas

There is no render host (owner ruling 2026-10-02). Nothing in the distribution
renders, and no Linux Chromium is downloaded or probed for.

- **The agents' browser.** A WSL agent's `browser.*` calls are the desktop's
  `browser` toolset, forwarded by the front door (3.7). A dev server an agent
  starts in WSL (`npm run dev` on `0.0.0.0:3000` or `127.0.0.1:3000`) is
  reachable from the person's Windows pane through localhost forwarding, as
  today. With forwarding off (`localhostForwarding=false`, or the stdio
  bridge in use), the pane cannot reach it, as today; phase 8's proxied
  partition over the bridge is a later option.
- **The canvas.** `canvas.*` calls are the desktop's `canvas` toolset,
  forwarded the same way. Boards do not move in phase 7: the desktop's canvas
  service keeps them through the Windows-side server's `files.*`, where they
  are today. Whether a WSL workspace's boards move into its distribution's
  server is decided with phase 8's environment list, as the workspace list is
  (5.4).
- **With no desktop attached**, an agent has no browser or canvas tools. In
  phase 7 that cannot happen: a WSL server runs only while the front door
  holds its lease (3.5), and the front door is the desktop, whose shell offers
  its toolsets with no window open (the tray). If a later phase lets a WSL
  server run on its own, its agents work without those tools until a client
  offers them.

### 3.9 Upgrades

1. The new app installs `<newVersion>/server/` beside the running
   `<oldVersion>/server/`. The commit script's `live` check (`/proc/*/cmdline`
   names `<old>/server/`) keeps the old tree.
2. The front door calls `server.shutdown { drain: true }` on the old server and
   waits for it to release `studio.lock` (bounded at 30 s, then kill).
3. It starts the new server on the same data dir. Data migrations run on first
   open, behind a copy of each rewritten file (parent 10.3).
4. **The gap.** Between the old server releasing `automation.sock` and the new
   one binding it, an agent's MCP call fails. Agents that survive the drain are
   suspended, so in practice no agent is live. The bridge reconnects with a
   short retry on `ECONNREFUSED`.
5. The old tree is pruned on the next install, once nothing names it.
6. **Node bumps** follow the same rule: `runtime/node-<v>` is installed beside
   the old one and pruned when no process names it.

A desktop older than the running server's protocol window is answered by the
handshake error that names both numbers. The front door then offers the
per-process path for that distro until the app updates. It never downgrades
the server's data in place.

## 4. Security

### 4.1 What crosses from Windows to Linux

| Secret | How it crosses | Never |
| --- | --- | --- |
| Owner token (32 random bytes) | In the envelope on the starter's stdin. The server stores only its hash. A front door that restarts while the server still runs reads `run/owner-token` with `wsl.exe --exec cat`, after the server writes it (0600), as the SSH design does. Running as this Windows user and landing as the distro's default user is the proof | argv, environment, `WSLENV`, a file under `/mnt/c` |
| Provider API keys | Once, `providers.secrets.set`, over the authenticated connection, during migration (7.3) | Through the bridge as files, or in any log |
| CLI logins | Do not cross. They already live in the Linux home (`~/.claude`, `~/.codex`, …) | — |
| Tickets | Minted by the server over the front door's owner connection, single-use, 30 s on the server's clock | Minted on Windows and checked on Linux (clock drift, 3.5) |

### 4.2 The loopback handshake authenticates both ends

The parent design sends the owner token in `hello`. That is not safe on WSL's
loopback. In NAT mode, the Windows-side listener is created by WSL's relay. If
another Windows process already holds that port number on Windows loopback,
forwarding for it fails and **the client connects to that process instead**
(**unverified: exact behaviour on collision, V3**). Windows loopback is also
reachable by every Windows user session on the machine.

So on loopback:

- The client sends `hello { nonce }` and **no secret**.
- The server answers `challenge { serverNonce, proof: HMAC(ownerToken, "server" ‖ nonce ‖ serverNonce) }`.
- The client verifies the proof before it sends anything else, then answers
  `HMAC(ownerToken, "client" ‖ serverNonce ‖ nonce)` (or a server-minted
  ticket bound to that `nonce`).
- An impostor learns nothing it can replay, and the client never takes a fake
  approval prompt from one.

Renderers that hold no token get `{ ticket, nonce, expectedProof }` from main,
which computes the proof itself. The same exchange runs over the stdio bridge.
It costs nothing there and keeps one handshake.

### 4.3 Listeners

- Owner socket in `run/` (0600 in an 0700 directory), and loopback
  `127.0.0.1`. That is all.
- **No tailnet listener in WSL.** In mirrored networking mode, Windows' own
  network interfaces, including the Tailscale one, appear inside the
  distribution. The tailnet bind check (`isAllowedTailnetBindAddress`) would
  accept a `100.x` address there, and two Studio tailnet listeners would
  contend for one address. The envelope forces `tailnet: false`. The server
  also refuses to start a tailnet listener when it detects WSL
  (`/proc/sys/fs/binfmt_misc/WSLInterop` or `WSL_DISTRO_NAME`) unless started
  with an explicit owner flag. The phone keeps reaching WSL chats through the
  Windows lane and the router (5.3).
- **Mirrored mode and `0.0.0.0`.** In mirrored mode, a Linux listener on
  `0.0.0.0` is a listener on the PC's LAN interfaces, subject only to the
  Hyper-V firewall. The bind guard makes this impossible for the Studio server.
  Agents' own dev servers are the person's business, as today.
- `Host` must be a loopback name and any `Origin` must be the server's own on
  the loopback listener (parent 9.2). Tests cover both, including DNS-rebinding
  shapes.

### 4.4 Secrets at rest

Recommendation (D4): a data key in `run/data.key` (0600), as on SSH hosts. The
alternative, a key held sealed by Windows DPAPI and sent in the envelope,
protects against only one extra case: an offline copy of the distro's `ext4.vhdx`
without the Windows credentials. BitLocker is the right answer to that case. The
same Windows user can open both, through `\\wsl.localhost` and DPAPI alike.
The DPAPI approach would also make a server started from a WSL terminal unable
to read its own secrets. WSL rarely has a Secret Service (no D-Bus session
without systemd and a keyring daemon), so `libsecret` is not a default here.

## 5. Routing: the front door and the `ConversationBackend` seam

### 5.1 The seam

A `ConversationBackend` interface is extracted from the public surface the
in-process consumers use today:

- `listSessions`, `onEvent`, `subscribe`, `send`, `interrupt`, `respond`,
  `setModel`, `setPermission`, `revert`, `rewind`, `fork`, `start`, `stop`,
  `suspend`, the thread index and search;
- what `ConversationSessionApi`, the tailnet conversation host, the module
  conversation service, scheduled agents and the companion agent service call.

There are three implementations:

- `LocalConversationBackend`: today's `ConversationRuntime`.
- `RemoteConversationBackend`: an SDK client to another server, implementing
  the same calls over `conversation.*`.
- `RoutedConversationBackend`: picks one per call from the workspace id, using
  the front door's workspace registry (`workspace.hostId`) and the per-distro
  switch (7.1).

Every consumer is moved onto the interface **before** any WSL routing exists,
in a pure refactor commit. That is what keeps goal 3 ("nothing that worked
stops working") true for the phone, scheduled agents, gateway tools and
modules.

### 5.2 `WslEnvironmentManager`

- It lives in the Windows-side core, not in Electron main. It needs no
  dialogs, so nothing about it is shell work. Main runs it before phase 6 and
  the local server runs it after.
- Each distro gets a lazily started `WslServerHandle`: start, lease, transport,
  owner connection, restart policy (the helper's backoff and fatal-hold rules),
  status for Settings.
- Distros are independent. Each has its own server, port, data dir,
  `environment.id` and failure state. One broken distro never blocks another.

### 5.3 What is routed, by operation

| Operation | Workspace on a WSL machine, folder in the distro (`\\wsl.localhost\…`) | Workspace on a WSL machine, folder on a Windows drive (`C:\…`) |
| --- | --- | --- |
| Conversations, providers, agent spawn, approvals, plans, attachments store | WSL server | WSL server |
| Checkpoints, turn diffs, changed files, revert (git) | WSL server (Linux git) | WSL server (Linux git over `/mnt/c`). One git per repository, as ruled 2026-09-24 |
| @-mention search, `stat`, image preview, skill reader | WSL server (native ripgrep on ext4: faster than today's Windows ripgrep over UNC) | **Windows side**, native on NTFS (Linux ripgrep over `/mnt/c` is slower than today) |
| Model discovery, `/` command catalog | WSL server (removes today's "not listed before a chat starts on WSL" gap) | WSL server |
| Git pane, file explorer, terminals | Shell, through the helper (unchanged in phase 7) | Shell, through the helper (unchanged) |
| Watch hints | — | Windows side → `workspaces.touch` |

### 5.4 Workspaces on the WSL server

In phase 7 the person's workspace list stays where it is: in the front door's
registry, with Windows spellings and `hostId: 'wsl:<distro>'`. The WSL server
holds only the workspaces it was asked to serve (`workspaces.ensure`), under the
same ids, with Linux roots and `hostId: 'local'`. Ids are random
(`workspace-registry-service.ts`), so they survive the respelling. Moving the
whole list to per-environment registries is the environment work of phase 8.

### 5.5 Workspace ids and project keys

- The phone's `deriveWorkspaceId` / `projectKey`
  (`mobile/control/workspace-id.ts`) hash the resolved root. Because the
  tailnet lane stays on the Windows side and reads the front door's registry,
  these keys keep their Windows-spelled inputs and do not change. A test pins
  that.
- Changelists (`git-changelists.ts`) and pull-request records hash
  `comparablePath(repoRoot)`. They stay with the Git pane on the Windows side
  in phase 7.

### 5.6 Paths at the edge

- **The protocol reports paths in the server's native spelling.**
  `welcome.environment` gains
  `paths: { style: 'posix', wsl?: { distro, driveMountRoot } }`.
- The front door's router translates only the **typed path fields** it
  forwards:
  - `workspaceRoot` / `cwd` are respelled with `toWslPath`, with the drive
    mount root the server reported;
  - workspace-relative file references in attachments and mentions;
  - absolute paths in typed results (`turnDiff` roots) are respelled with
    `wslToWindowsPath(…, { distro })`.
- Free text and tool inputs inside events are **not** rewritten. The renderer
  resolves links with the environment's path style, so an agent's
  `/home/dev/repo/a.ts` opens as `\\wsl.localhost\Ubuntu\home\dev\repo\a.ts`.
  Today the chat link resolver (`agentChat/conversationLinks.tsx`) does not
  pass a distro, so absolute `/home/…` links from WSL agents already render as
  plain text. Phase 7 fixes that by passing it.
- **`driveMountRoot` is learned, not assumed.** `toWslPath` hard-codes
  `/mnt/<drive>`. A distro with `[automount] root = /` or `root = /win/` in
  `/etc/wsl.conf` breaks that today. The server reports the root it finds
  (`wslpath -u 'C:\\'`, or `/etc/wsl.conf`). The edge helpers take it as a
  parameter, defaulting to `/mnt/`. A distro with automount off cannot serve a
  `C:\` workspace at all, and the environment says so when such a workspace is
  routed there.
- As built (2026-10-03): `toWslPath` and `wslToWindowsPath` take a
  `driveMountRoot` (default `/mnt/`). The server reads the root from
  `/proc/mounts` (a `9p` or `drvfs` mount whose source is a drive), falling
  back to `/etc/wsl.conf`'s `[automount]` section (`driveMountRootFromMounts`,
  `driveMountRootFromWslConf`), and reports it in `ready`. The helper is not
  changed: the per-process path keeps assuming `/mnt/`, as it does today.

## 6. Which server owns a `C:\` workspace

**Rule: the workspace's machine decides, as it does today.**

- `hostId: 'local'` (any folder) goes to the Windows local server, natively,
  with Windows git.
- `hostId: 'wsl:<distro>'` goes to that distro's server, whether the folder is
  in the distro or on a Windows drive.
- A folder inside a distro (`\\wsl.localhost\…`) always goes to that distro's
  server, **whatever `hostId` says**. A Windows-side server running Windows
  agents and git against a Linux repository over 9P is the case the
  2026-09-24 rule exists to prevent, and the git resolver already gives the
  folder precedence (`app-services.ts`, `byFolder` first). The router uses the
  same precedence.

Why not move `C:\` workspaces to a Windows-local server regardless of machine:

- **The machine is the person's choice of runtime.** A `C:\` folder bound to
  WSL exists because the person wants Linux CLIs and toolchains on it. Running
  its agents on Windows would change the machine under them, and a resumed CLI
  session lives in the Linux home (`resolveLaunchHostId` never moves a bound
  session).
- **Git line endings and the index.** Linux git and Git for Windows on one
  work tree disagree about `core.autocrlf` (Git for Windows commonly
  normalises to CRLF on checkout), about `core.fileMode` (the drive mount
  reports permissive modes unless mounted with `metadata`), and about the
  index's stat data. Each one re-stats or re-hashes what the other wrote,
  phantom modifications appear, and `worktree add` writes `gitdir` links that
  only one side can follow. Today's rule (one git per repository, the
  workspace's machine's git) holds only if the server choice follows the
  machine.

Why not route `C:\` folders on WSL machines to WSL wholesale, file reads
included:

- **Performance of `/mnt/c` on WSL2.** File access crosses a 9P file server.
  Metadata-heavy operations (`git status`, ripgrep across a tree, `stat` storms)
  are much slower than on NTFS from Windows or on ext4 inside the distro.
  Windows Defender's real-time scan sits on the NTFS side of every such open.
  The size of the gap is **unverified here (V4)** and is measured in the
  phase's benchmark (9.3).
- So the router keeps **UI file reads for `C:\` folders on the Windows side**
  (5.3) and sends only what must be Linux (agents, git) to WSL.
- New chat shows a one-line note when a WSL workspace is created on a Windows
  drive: "Faster in the Linux file system: clone into ~/ in this
  distribution". It is advice, not a block.

The sidecar of a `C:\` workspace stays at `C:\…\.sprintengine\`. From now on
the WSL server writes it over `/mnt/c`. The writes are appends and
rename-into-place, both of which the drive mount supports **(unverified:
`rename` atomicity over the WSL2 drive mount under concurrent readers, V5)**.

## 7. Migration and the per-process fallback

### 7.1 One owner per distro, switched explicitly

- `ExecutionHostSettings` gains `chatServer?: 'off' | 'on'` (absent means the
  release default). The router reads it per distro.
- **The switch is per distro, not per workspace or per chat.** The thread index
  and transcripts in a workspace's sidecar have exactly one writer. Windows
  main writing over `\\wsl.localhost` and a Linux server writing natively share
  no lock (a Linux `flock` is invisible to a Windows writer over 9P). Only "all
  chats on this distro are owned by one side" makes concurrent writers
  impossible.
- **A flip happens only with no live chat session on that distro.** Sessions
  are suspended first (stateful providers keep their resume cursors), the flip
  migrates (7.3), and the next send resumes on the new owner. A CLI session
  resumes on whichever side owns the distro, because CLI logins and transcripts
  are in the Linux home either way.

### 7.2 Fallback

- **Automatic fallback** to the per-process path happens only for a distro the
  server has **never** owned: WSL1 (D2), Node will not run (glibc below 2.28,
  musl, an unsupported architecture), or the install fails. The environment
  shows why, and chats there run as they do today.
- Once the server has owned a distro, a failure **does not** silently fall back,
  because the attachments, plans and rules for chats made since are in the
  server's data dir. The person gets the reason, Retry, and "Use the
  per-process path for this distribution", which runs the reverse migration
  when the server can still start, or warns which chats' attachments and plans
  will be missing when it cannot.
- **Release plan.**
  - Release N: off by default, opt-in in Settings › Machines.
  - Release N+1: on by default, with the per-process path available per
    distro.
  - Release N+2: the per-process chat path is removed (`cli-host-child.ts`'s
    WSL branch, `claude-wsl-child.ts`, `mcpServersOnWsl`,
    `approvalCheckInput`'s respelling and the ACP and Codex path mapping),
    unless D2 keeps WSL1 on it.

### 7.3 What moves on the first flip of a distro

All of this runs once, idempotently, with a receipt per workspace in the
server's data dir:

- **Workspace adoption.** `workspaces.ensure` for each WSL workspace on the
  distro (5.4).
- **Approval rules.** Each rule whose `workspaceRoot` is one of those
  workspaces is re-keyed to the Linux root and sent to the server. They are
  removed from the Windows file only after the server confirms.
- **Attachments and plans.** The files are copied into the server's store,
  under keys computed with the Linux root (the key is
  `sha256(root\0workspaceId\0agentId)`, so copying is re-keying), then removed
  on the Windows side after confirmation.
- **Provider API keys.** Each is sent once with `providers.secrets.set`
  (D5). The front door records which environment has which key's version, so a
  key changed later in Settings is offered to the WSL servers, not pushed
  silently.
- **Not moved.** Transcripts, tool details, the thread index and checkpoint
  refs are already in the workspace (sidecar and git) and are read in place.
  CLI logins are already in the Linux home.

The reverse migration runs the same steps in the other direction. Both are
owner-only protocol calls (`conversation.exportWorkspaceData` /
`importWorkspaceData`), and both have tests that run them back and forth.

### 7.4 Guards the server needs against Windows host ids

On the Linux server, `wsl:<distro>` host ids must mean nothing:

- `normalizeExecutionHostId` and `distroOfHostId` take the platform, and off
  `win32` a WSL id normalises to `local`.
- `approvalCheckInput` respells only on `win32`. It reads
  `distroOfHostId(cliRuntimes[cli].hostId)` with no platform guard today. On a
  Linux server holding a stray `wsl:` id, it would respell Linux paths into
  `//wsl.localhost/…` and Auto would approve nothing.
- `wslTargetForHost` returns null off `win32`, so a stray id can never make a
  Linux server spawn `wsl.exe`.
- `conversationCliRuntimesForHost` stamps no `hostId` for a workspace whose
  `hostId` is `local`. Adopted workspaces are always `local` (5.4).

As built (2026-10-03): `distroOfHostId` and `normalizeExecutionHostId` take
an optional platform, and the runtime is the one door. `ConversationRuntime`
drops every `wsl:` id from a start's `cliRuntimes` off Windows
(`cliRuntimesOnPlatform`), before a provider or the approval check sees it,
and `approvalCheckInput` reads the distribution with the runtime's platform.
`wslTargetForHost` is left as it is: every provider reads the runtimes the
runtime hands it, so no stray id reaches one, and the providers stay
untouched for the change that gives Codex and ACP chats the gateway (R86).

## 8. Edge cases

| # | Case | Behaviour | Verified? |
| --- | --- | --- | --- |
| 8.1 | **WSL1** | No VM, Windows loopback shared directly, no inotify for Windows-side changes on drive mounts. Node 24's documented kernel floor (4.18) is above what WSL1 reports. Recommended: per-process path (D2) | Node 24 on WSL1 unverified (V6) |
| 8.2 | **`localhostForwarding=false`**, `networkingMode=none`, or policy-disabled forwarding | TCP probe fails, stdio bridge used, reason shown | Bridge tested with fake `wsl.exe`; real case V1 |
| 8.3 | **Mirrored networking** | Loopback shared both ways; `127.0.0.1` bind works; port space shared with Windows (bind retry); Tailscale interface visible, so the tailnet listener is forced off | V1 |
| 8.4 | **Firewall / VPN / endpoint security** blocking loopback or the WSL relay | Probe or proof fails, bridge used. VPNs that break the WSL2 NAT network break agents' outbound calls today too, so no change. API-key chats (`openai-compatible-provider.ts`, plain `fetch` in-process) **move their egress from Windows to the distro**, so a Windows-only proxy or PAC file no longer applies. Shown as a network error naming the environment; the login env's `HTTPS_PROXY` is honoured | V7 |
| 8.5 | **Port squatter on Windows loopback** | The proof fails (4.2), the bridge is used, and the event is logged with the port | V3 |
| 8.6 | **Default user changed** (`wsl --manage <d> --set-default-user`, `/etc/wsl.conf [user]`) | The server starts under the new `$HOME`, so it has a new data dir and a new `environment.id`. The front door detects the mismatch and says "WSL: Ubuntu now signs in as dev2; chats made as dev are in that user's home". It does not migrate. It never passes `-u`, because terminals and CLI logins follow the default user | Logic tested; real change V8 |
| 8.7 | **Distro renamed, exported or imported** | The host id is the name (ruling 2026-09-24), so this is a new host. The data dir moved with the vhdx, so `environment.id` is unchanged, and the front door offers to rebind the workspaces of the old name | Logic tested |
| 8.8 | **Distro unregistered** | `distro-missing` (fatal). Workspaces show the machine unavailable and nothing retries | Classified by existing `classifyWslFailure` |
| 8.9 | **Multiple distros** | One server each, started lazily. They share the one WSL2 VM's memory (`.wslconfig memory=`). A failure in one is contained | — |
| 8.10 | **Two Windows profiles** (packaged and dev build, or `SPRINTENGINE_USER_DATA_DIR`) on one distro | Separate data dirs (`data/` and `data-<profileId>/`, D3), so separate servers, as the helper already separates sockets per profile | — |
| 8.11 | **Two app versions** (stable and nightly) wanting one data dir | The lock admits one server. The second app attaches if inside the protocol window, otherwise it shows the version message and uses the per-process path for that distro until the versions converge. Never two servers on one data dir | Skew tests |
| 8.12 | **systemd off** | No `XDG_RUNTIME_DIR`, so sockets stay in `run/` or fall back to `/tmp/sprintengine-<uid>` with ownership checks. No user units in phase 7 | Helper already covers this; server reuses the code |
| 8.13 | **systemd on** | Works the same. Whether a systemd user service would hold the instance alive is not relied on (V2). A unit is a later option | V2 |
| 8.14 | **glibc below 2.28 or musl** (Ubuntu 18.04, Alpine) | `node-run` fatal at the server tree's commit check, so the per-process path is used, which also needs the helper. Neither works today for these distros, so this is no regression | Classified today |
| 8.15 | **Slow or hung login profile** | 8 s capture deadline, fallback env, a note in the chat surface. Paid once per server start, not per chat | Helper tests cover the capture |
| 8.16 | **`wsl --shutdown` mid-chat** | 3.5: deliberate stop detected, turn interrupted, no auto-reboot | Fake-`wsl.exe` test; real V9 |
| 8.17 | **`vmIdleTimeout` / instance idle** | The lease keeps the instance up while needed. Dropped after 10 minutes unused (D6) | V2 |
| 8.18 | **Windows sleep or hibernate** | Heartbeat miss, reconnect, resume from cursors. No cross-clock credential checks | Reconnect test; real V9 |
| 8.19 | **Watching `\\wsl.localhost` from Windows** | Hears nothing, as the helper's own comment records. Chat-side watches move into the server; the Git pane keeps the helper's watches | — |
| 8.20 | **UNC spellings** (`\\wsl$` vs `\\wsl.localhost`, distro-name case) | `comparablePath` at the edge. The server never sees a UNC path | Existing tests |
| 8.21 | **Automount off or relocated** | `driveMountRoot` learned (5.6). `C:\` workspaces on that distro are refused with the reason | New tests |
| 8.22 | **Agent's `/home/…` link in a chat** | Opens via the UNC translation with the environment's distro (5.6); plain text today | New renderer test |
| 8.23 | **Drag a file from Explorer** | Bytes uploaded (3.6). A file inside the workspace goes as a relative path | — |
| 8.24 | **CLI sign-in with a localhost OAuth callback** | The CLI listens inside WSL; the Windows browser redirects to `localhost:<port>`, which reaches it only with forwarding or mirrored mode. Same as a WSL terminal sign-in today; a device-code flow is preferred where the CLI has one | V10 |
| 8.25 | **Windows Defender / EDR** | Fewer Windows process creations than today (no `wsl.exe` per chat CLI, and no `eval $(… base64 -d)` command lines, a shape heuristic EDRs flag). The archive lands in ext4 and is not scanned on the NTFS side. `/mnt/c` traffic is still scanned on the NTFS side (6). The downloaded Node archive in userData is scanned once | V11 |
| 8.26 | **Disk and memory** | The data dir lives in the distro's vhdx, which grows and does not shrink by itself; Settings shows the data dir size. The server and the CLIs share the VM's memory cap | — |
| 8.27 | **Long `$HOME` / socket path over 100 bytes** | Falls back to the runtime dir (3.1) | Unit test |
| 8.28 | **The app updated while the server runs** | 3.9 drain-and-replace; the old tree is kept while live | Install tests |
| 8.29 | **Front door restarts while the server lives** | Reads `server.json` and `owner-token` over `wsl.exe --exec`, takes a new lease, reattaches | Test with a fake |

## 9. Test strategy

### 9.1 Without WSL (CI on Linux and macOS, every commit)

- **The fake `wsl.exe`.** This extends the pattern already in
  `src/main/hosts/wsl-helper/helper-e2e.test.ts`: a real `sh -s` with
  `HOME=<temp>` stands in for `wsl.exe --exec sh -s`, and the real client
  starts the real helper.
  - A `FakeWsl` spawner maps `-d <distro> --cd ~ --exec <argv>` to a local
    spawn, with a per-distro temp `$HOME` and `WSL_DISTRO_NAME` set.
  - Scripted failures: UTF-16LE error text (`WSL_E_DISTRO_NOT_FOUND`), exit
    126/127 with `GLIBC_` text, `--list` showing `Stopped` after a kill
    (simulating `wsl --shutdown`), and a slow first boot.
  - All server-path tests run on it.
- **Install.** `wsl-install.test.ts` gains the server tree: staging, marker,
  `--version` check, pruning with a live server (a fake `/proc` via the
  existing `SPRINTENGINE_HELPER_PROC_ROOT` seam), and a pin that `data*/` is
  never pruned.
- **Bootstrap.** Covers `boot` before envelope, envelope parsing, `ready`,
  lease heartbeats and EOF, the fatal hold, and a crash restart with
  subscriptions resumed from cursors and no duplicated text.
- **Transports.**
  - TCP against the real server bundle on loopback.
  - The stdio bridge against a real `bridge.mjs` spliced to the owner socket
    through the fake `wsl.exe`, including an HTTP upload and a signed image
    fetch over the bridge.
  - **Squatter**: a decoy listener on the reported port fails the proof, and
    the client falls back without sending a token.
  - A bind-guard test refuses `0.0.0.0`, `::` and a tailnet address.
- **Routing.** `RoutedConversationBackend` with one local and one remote
  backend (a real second server in a temp dir). The tailnet conversation host,
  module conversation service, scheduled agents and gateway
  `conversation.create` all drive a chat on the "WSL" backend unchanged.
- **Migration.** Approval rules, attachments and plans re-keyed and moved there
  and back, receipts making each run idempotent, a refusal while a session is
  live, and a partial failure leaving the source intact.
- **Path edge.** Typed-field translation with `driveMountRoot` `/mnt/`, `/`
  and `/win/`; renderer link resolution of `/home/…`, `/mnt/c/…` and relative
  paths with an environment path style; the platform guards in 7.4 (a Linux
  server with a stray `wsl:` id spawns no `wsl.exe` and respells nothing).
- **Server on Linux, as if in WSL.** The js-tests job boots the Linux server
  bundle **on the pinned `v24.21.0`**, not the runner's Node, with a temp
  `$HOME` and `WSL_DISTRO_NAME=Fake`. It runs a mock-provider chat, a revert,
  an MCP `conversation.create` through the server's own gateway, and a forwarded
  tool answered by a fake front door.

### 9.2 On Windows CI

- The `windows-latest` leg of `ci.yml` today runs typecheck, one test file and
  the build. Phase 7 adds the Windows-side unit tests for
  `WslEnvironmentManager` with the fake spawner (no WSL needed): argv shapes,
  UTF-16 decoding, transport selection.
- GitHub-hosted Windows runners cannot run WSL2 (no nested virtualisation),
  and WSL1 through a setup action is the most a hosted runner offers
  **(unverified)**. A WSL2 job needs a self-hosted Windows runner (D9).

### 9.3 A real machine: the manual checklist, before the default flips

Each item must be run on Windows 11 with WSL2 and an Ubuntu 24.04 distro, and
the results recorded in the release notes for release N:

- **V1.** Loopback forwarding of a `127.0.0.1`-only listener: NAT mode
  (default), NAT with `localhostForwarding=false` (expect the bridge), and
  mirrored mode. Time from `listen` to first successful Windows connect.
- **V2.** Does a `setsid` server keep the instance alive with no `wsl.exe`
  left? With systemd on and off. (The design does not rely on it either way.)
- **V3.** A Windows process holding the port before the server binds it:
  what the Windows client reaches.
- **V4.** `git status` and a mention search on a 50k-file repo: ext4 via the
  server, `/mnt/c` via the server, and `C:\` natively.
- **V5.** Sidecar appends and rename-into-place over `/mnt/c` with the
  Windows-side reader open.
- **V6.** Node 24 and the server on a WSL1 distro.
- **V7.** A corporate VPN and an HTTP proxy: chat over loopback, API-key chat
  egress.
- **V8.** Default user change.
- **V9.** `wsl --shutdown` mid-turn; sleep and resume mid-turn.
- **V10.** Sign-in for each CLI from a chat on the WSL server.
- **V11.** Defender real-time protection on: install time, first-chat time.
- **Upgrade.** App N with a running server, then update to N+1 and send a
  message.
- **Throughput.** Bridge vs TCP for a 64 MiB tool detail and a 10 MiB image
  upload.

## 10. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| In-process consumers bypass the router | The phone, scheduled agents or gateway lose WSL chats | The seam lands first as a refactor (commit 1–2). A guard test fails if any file outside the backend modules imports `ConversationRuntime` |
| Two writers on a sidecar during a flip | Corrupt thread index or transcript | Per-distro owner, flips only with no live session, a receipt per workspace, and a test that the losing side refuses writes after the flip |
| Token sent to an impostor on Windows loopback | Credential theft, fake prompts | Mutual proof before any secret (4.2) |
| `0.0.0.0` or tailnet exposure in mirrored mode | A Studio listener on the LAN | Bind guard before `listen`, `tailnet: false` forced, WSL detection refusing a tailnet listener |
| Instance stopped under a server | Lost turns | The lease is a real `wsl.exe` session. The drain budget fits the window. The event log survives torn writes |
| `/mnt/c` performance regression for `C:\` workspaces | Slow mentions, stale changed files | UI file reads stay on Windows (5.3), watch hints, a measured benchmark (V4) before the default flips |
| Migration loses attachments, plans or rules | Missing context in old chats | Copy, then confirm, then remove. Reverse migration. Receipts. Tests both ways |
| Login profile differences | A CLI found per-process but not by the server, or the reverse | Same capture code as the helper's CLI detection, which is already what the machine picker shows |
| API-key chat egress moves into the distro | Proxy-dependent chats fail | Named error, login-env proxy honoured, release note |
| Memory: a server per distro | VM pressure | Lazy start, idle exit; nothing renders in the distribution (3.8) |
| Phase size | It slips | The breakdown in section 13 lands value at commit 6 (chat on a WSL server behind the switch) with everything after it independently revertible |

## 11. Owner decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | **Front door vs direct.** In phase 7, does the Windows-side core route WSL chats (renderers, phone, gateway and modules unchanged), or do renderers connect to each WSL server directly, as the SSH design does? | **Route through the front door.** It is the only shape that keeps every in-process consumer working without each learning about environments. Direct connections arrive with phase 8's environment list and can use the same servers |
| D2 | **WSL1.** Run the server there, or keep WSL1 on the per-process path? | **Per-process path for WSL1.** No drive-mount inotify, kernel below Node 24's floor, likely few users. Revisit when the per-process chat path is due for removal: removing it then means dropping WSL1 chats |
| D3 | **Data dir per Windows profile or per distro?** | **Per profile**: `data/` for the packaged default profile, `data-<profileId>/` otherwise, matching how the helper already separates sockets per profile, so a dev build never shares chats with the installed app |
| D4 | **Secrets at rest in WSL**: a 0600 key file, or a DPAPI-held key sent in the envelope? (extends parent Q3) | **Key file.** Same protection boundary in practice, works for a server started from a WSL terminal, symmetric with SSH |
| D5 | **Copy provider API keys into each WSL server on its first flip?** | **Yes, once, automatically**, with a line in the migration notice, because those keys already powered that distro's chats. Later edits are offered, not pushed |
| D6 | **Idle policy**: how long a WSL server lives with no window, turn or subscription on its distro | **10 minutes**, then the lease drops and the VM can idle. Background mode keeps it up |
| D7 | **Transport order**: keep TCP first (ruling d), or make the stdio bridge primary for the desktop? | **Keep TCP first with mutual proof**, because it serves browser tabs and SDK scripts on Windows too. Ask again if V1 or V3 show surprises: the bridge needs no port at all |
| D8 | **Helper and server**: two processes in phase 7, merged in phase 10? | **Two now.** The helper's private wire stays version-locked and the Git pane and terminals keep working untouched. Merge when the Git pane and explorer move to the protocol |
| D9 | **A self-hosted Windows runner with WSL2** for an end-to-end job, or the manual checklist (9.3) per release? | **Checklist for release N**, and a self-hosted runner before release N+1 flips the default |
| D10 | **`C:\` workspaces on a WSL machine**: keep supporting them (recommended, with Windows-side UI reads and an advisory), or steer new WSL workspaces into the Linux file system only? | **Keep supporting**, advise in New chat, and never block |
| D11 | **The live gateway-token gap for today's WSL chats** (2, item 3): fix on `main` now, independently of phase 7? | **Done**: fixed on `main` (#133), a channel token issued and revoked per chat session |

## 12. Changes the parent design needs

1. **Section 3.3 / phases 2–4: a `ConversationBackend` seam.**
   `ConversationSessionApi` is not the only boundary. The tailnet host, module
   conversation service, scheduled agents and companion agent service call
   `ConversationRuntime` directly. Extract the interface in phase 3 so phases
   7 and 8 can route.
2. **Section 9.1: the owner socket serves the whole HTTP surface** (WebSocket
   upgrade, uploads, signed asset URLs), not just frames. That is what lets one
   byte-pipe (the WSL bridge, an SSH `-L` to a socket) carry everything.
3. **Sections 5.4 / 5.5: the SDK takes a transport, not a URL**: WebSocket URL,
   Unix socket, `MessagePort`, or any duplex.
4. **Sections 9.1–9.2: loopback auth is mutual.** A bearer token in `hello` on
   TCP is replaced by the challenge in 4.2 wherever the listener could be
   squatted (WSL forwarding, SSH `-L` to a local port).
5. **Section 10.2 step 2: no reliance on `setsid` for lifetime.** The starter's
   `wsl.exe` stays open as the lease. Step 4's "idles out like the helper" is
   kept, but the idle clock is the front door's.
6. **Section 10.2 step 3: the stdio fallback** is a byte bridge to the owner
   socket, not WebSocket frames over the starter's stdio.
7. **Section 5.5 "spawning `wsl.exe` is the shell's job"**: WSL servers are
   managed by the Windows-side core (`WslEnvironmentManager`). Only SSH needs
   the shell, for askpass dialogs.
8. **Section 6.3: the `terminal` toolset is offered to the WSL servers of the
   desktop's own PC** (through the front door, 3.7), because the desktop can
   open terminals there. The parent's rule says "only to a server on its own
   machine".
9. **Section 6.2: `~/.sprintengine/bin/current` in a distro keeps one writer**
   (the Windows side) until terminals move. The parent says the WSL server
   rewrites it at start, which would make two writers.
10. **Sections 8.1 / 8.4: superseded (2026-10-02).** This asked for the
    attached desktop's renderer to be preferred over a Linux Chromium in WSL.
    There is no Chromium and no render host now; the desktop's toolsets serve
    a WSL server through the front door (3.7, 3.8).
11. **Section 7.1: the WSL data dir is per Windows profile** (D3).
12. **Section 13, phase 7 size: M becomes L.** It includes the backend seam,
    the router, the migration both ways, the mutual handshake and the bridge.
13. **Section 6.3 (2026-10-02): forwarded tools are client toolsets.** The
    front door offers a WSL server the toolsets it can serve, with
    `tools.offer` under the shell role, and relays their calls (3.7). The
    `gateway-forward:<tool>` capabilities an earlier draft of this file named
    are not needed.

## 13. Commit breakdown

Each commit leaves `npm run verify:app` green and the app shippable. Commits
1–5 change nothing a person sees. Commits 6 onward are behind
`chatServer: 'on'`.

1. **`refactor(conversation): a ConversationBackend interface over the runtime`.**
   Extract the interface. `ConversationRuntime` implements it. No behaviour
   change.
2. **`refactor(conversation): every in-process consumer takes a ConversationBackend`.**
   Tailnet host, module conversation service, scheduled agents, companion
   agent service, the IPC handlers. Guard test on direct runtime imports.
3. **`fix(hosts): WSL host ids mean nothing off Windows`.** The 7.4 guards
   (`normalizeExecutionHostId` platform, `approvalCheckInput`,
   `wslTargetForHost`), with tests.
4. **`feat(hosts): learn a distribution's drive mount root`.** The
   `driveMountRoot` parameter through `host-paths.ts`, read by the helper
   today and by the server later. Tests for `/`, `/mnt/`, `/win/` and
   automount off.
5. **`feat(server): mutual proof on the loopback handshake, and a byte bridge to the owner socket`.**
   The 4.2 challenge, `bridge.mjs`, the SDK transport interface, the bind
   guard, and HTTP on the owner socket. Tested on Linux with a decoy listener.
6. **`feat(wsl): install and start a Studio server in a distribution`.** The
   server tree in `wsl-install.ts`, the launch-script `entry`,
   `startWslEntry` extracted from the helper client, envelope, ready, lease,
   `WslEnvironmentManager` with the fake `wsl.exe` tests. Nothing routes to it
   yet.
7. **`feat(conversation): route a WSL workspace's chats to its distribution's server`.**
   `RemoteConversationBackend`, `RoutedConversationBackend`,
   `workspaces.ensure`, typed-field path translation, the
   `chatServer` setting (default off), and Settings › Machines showing the
   server's state, transport and reason.
8. **`feat(conversation): move a distribution's chat data to its server and back`.**
   Export/import, re-keying approval rules, attachments and plans, provider
   key copy, receipts, the no-live-session flip.
9. **`feat(server): a chat agent in WSL reaches its server's gateway, and forwarded tools`.**
   The server-local MCP entry and discovery, the front door's toolset offers
   and call relay (3.7, on phase 5's mechanism), native hooks and agent
   state.
10. **`feat(chat): files, watching and links for WSL workspaces at the edge`.**
    Windows-side UI reads for `C:\` folders, watch hints and the slow poll, the
    renderer's link resolution with the environment's path style, byte uploads
    for dropped files.
11. **`feat(wsl): a server outlives nothing it should, and survives what it must`.**
    Idle lease drop, deliberate-shutdown detection, crash restart, reattach
    after a front-door restart, drain-and-replace upgrades.
12. **`docs(conversations): how a chat runs on a WSL machine with a server`**,
    and the manual checklist (9.3) as `docs/wsl-server-checklist.md`.
13. *(Release N+1)* **`feat(wsl): chats run on the distribution's server by default`.**
14. *(Release N+2)* **`refactor(chat): the per-process WSL chat path is removed`**,
    subject to D2.

Commits 3 and 4 are independent of the rest and can land on `main` first.
D11's token fix already has (#133).
