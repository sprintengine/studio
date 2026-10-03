# Studio server — decisions

Status: 2026-10-01, amended 2026-10-02 for the small-server ruling and
2026-10-03 for the ruling that any folder runs on the machine picked (R88).
Every class C item is ruled (2026-10-02, R88 on 2026-10-03). This file
resolves the open decisions of `docs/design/studio-server.md` (section 15) and
of the phase specs beside it (the withdrawn phase 5 spec's section 11, the
client-tools phase 5 spec's section 16, phase 6 section 14, phase 7 section
11, phase 8 section 11, phase 9 section 13, and the changes each asks of the
parent). Questions that already have a settled answer are decided here. Only
the rest go to the owner (owner ruling 2026-10-01).

Where a row changes what a spec says, the spec is amended in the same change
that lands that phase's first commit, as each spec already requires.

**2026-10-02: the server is small (owner ruling 2026-10-02).** The server
holds agents, conversations, tool routing between agents and clients, pairing
and permissions, and raw access to its machine (files, git, diffs,
workspaces). It has no browser and no canvas. Clients build the views and
offer toolsets, which the server exposes to agents and forwards calls to
(`docs/design/studio-server.md` section 1.1, and the new phase 5 spec,
`phase-5-client-tools.md`, which replaces the headless-rendering spec). Every
row that assumed a renderer in the server (a render host, a server Chromium
and its download, sandbox and fonts, screencast frames, render pools, the
canvas worker on the server and its fallback) is marked **Superseded
(2026-10-02)** with the reason, and keeps its ID. Rows R75–R79 are new: the
SSH pane, the web client's previews and canvas, and the shell's own toolsets
in phase 6. Rows R80–R86 are the client-tools spec's open decisions. R74 is
fixed on `main`.

## How to read the table

- **ID** is this file's row number. **Spec IDs** name where the question was
  asked: `Q5` is question 5 in the parent's section 15; `P5-D2`, `P6-O5`,
  `P7-D3`, `P8-D1` are the decision numbers in the phase 5–8 specs; `P9-3` is
  phase 9's owner decision 3; `§` points at a section of the named document.
  `P5-…` names the withdrawn headless-rendering spec (in git history); the
  new phase 5 spec's decisions are `P5c-1` and on.
  Duplicates across specs are merged into one row. Row numbers are stable
  labels, so a few rows sit out of numeric order in their section.
- **Class**:
  - **A, settled.** Decided now. The reason stands on its own.
  - **B, settled, deliberately strict or kept.** Decided now in favour of the
    stricter option, or of behaviour Studio already ships, over a simpler
    option that would have been weaker for Studio.
  - **C, owner.** No settled answer exists. The spec's recommendation stands
    as the working default until the owner rules. Listed again in the last
    section.
  - **Superseded (2026-10-02).** The ruling of that date removed the question.
    The row stays so its ID and history hold; it is not a decision any more.

## Decisions

### Process, lifetime and packaging

| ID | Spec IDs | Decision | Resolution | Class | Reason |
| --- | --- | --- | --- | --- | --- |
| R01 | Q2; P6-D6, P6-O7 | Local server lifetime; confirm before quitting with running turns | The desktop's local server exits with the app, always. Background mode (the tray) keeps the app, and so the server, alive. No quit confirmation. | A | One owner per process tree. A server that outlives its app runs agents nobody can see or stop, and a quit prompt is a new behaviour nobody asked for. |
| R02 | P6-D1, P6-O1 | How the desktop starts its local server | `utilityProcess.fork`, with the envelope by `postMessage`. The stdio bootstrap stays for WSL, SSH and CI. | B | A force-quit leaves no orphaned server (P6 E3), `ELECTRON_RUN_AS_NODE` never leaks into the agents it spawns (E6), and only a utility process can take a `MessagePort`. |
| R03 | P6-D2, P6-D3, P6-O2; P7 §12.3 | How desktop windows reach the local server | A `MessagePort` per window, brokered by main. No loopback listener for desktop windows. The SDK takes a transport, not a URL: WebSocket, Unix socket, `MessagePort` or any duplex. | B | The renderer never holds a credential, so no ticket, token or `Origin` rule is needed. A `file://` page's `Origin` identifies nothing (P6 E4). |
| R04 | P6-O8, P6-O9 | Default, rollback and automatic fallback | Flag off for the phase 6 release, a Settings → Advanced toggle and `SPRINTENGINE_SERVER_MODE`. In process stays for two releases after the default flips. Three failed boots fall back to in process, at boot only. | B | Studio is migrating a shipped in-process app. A server-only design with no way back would break goal 3 the first time the server cannot start. |
| R05 | §7.1; P6-D8 | One server per data directory | A run lock in `<dataDir>/run/` before anything is unlinked or opened. A second server on the same directory exits. | B | Two writers on one store corrupt it. The gateway unlinks a socket path at start, which must never happen under a live server. |
| R06 | P6-O10 | Server heap cap | No explicit `--max-old-space-size`. Node's own limit, sized from system memory, applies; a crash restarts with backoff. | A | A fixed cap is one more number to keep right across hosts, and Node already bounds the heap. |
| R07 | P6-O11 | The agents' MCP link across a server restart | Yes: the stdio bridge reconnects to the new gateway, in phase 6. | A | Without it, every server restart silently removes Studio's tools from running agents. |
| R08 | Q9 | Publish the server for machines without the desktop | Yes. Publish `studio-server` to npm and as a standalone archive, with a CLI: `serve`, `pair`, `token`, `status`, `stop`, and `service install` for people who want it run by systemd or launchd. | A | A headless box should not need a desktop install to run a server, and a published entry is what makes the protocol usable by third parties. |
| R09 | Q12 | Terminals on the server later | Out of scope until chat reaches parity on every route. When they come, they reuse the WSL helper's design. | B | Ruling (a). Keeps v1 to chat, and keeps the highest-volume stream in the shell. |
| R10 | P6-O3, P6-D4 | Secrets on the desktop in phase 6 | The shell is the cipher (`seal`/`open` over the control channel). The `*.bin` files stay byte-identical; no re-seal. | B | Keeps Keychain/DPAPI protection Studio ships today, and rollback stays a flag flip with no migration either way. Server-written plain files would weaken a desktop that has a keychain. |
| R11 | P6-O4 | Linux desktop where `safeStorage` falls back to `basic_text` | Select the Secret Service backend explicitly before `ready` whenever a desktop session can provide one. When none exists, keep today's behaviour and report it in Diagnostics. | A | `basic_text` is obfuscation, not encryption. Chromium picks the backend from the desktop environment's name, so an unrecognised desktop gets `basic_text` even with a Secret Service running. |
| R12 | Q3; P6 §9.2; P7-D4; P8 §12.9 | Secrets on headless hosts (WSL, SSH, started from a shell) | A key file in `<dataDir>/run/` (0600) inside a 0700 directory. No keyring probing, and no Windows-held key sent in from outside. `server.info` reports the choice. | A | SSH and WSL sessions almost never have an unlocked keyring (P8 §6.7). The CLIs' own logins on those hosts already rely on the same user boundary, and a server started from a WSL or SSH shell can still read its own secrets. |

### The protocol, packages and auth

| ID | Spec IDs | Decision | Resolution | Class | Reason |
| --- | --- | --- | --- | --- | --- |
| R13 | Q1; P9-11 | Package names | `@sprintengine/studio-protocol` is the Studio wire (owner ruling 2026-10-01, landed in phase 2): types and parsers only, depending on `@sprintengine/conversation-protocol` and re-exporting all of it, so the conversation package stays the phone's subset with its pinned files untouched. Client logic goes in separate packages: `@sprintengine/agent-sdk`, `@sprintengine/conversation-timeline` and `@sprintengine/conversation-view`. | A | The owner ruled the name, and the package exists. One import for third parties, one versioning policy for the wire, and client behaviour kept out of it, so the phone's pin stays stable. |
| R14 | §9.2, §5.5; P9 §6.3, §12.2 | WebSocket tickets, `Origin` and `Host` | Tickets are single-use and live 30 seconds. Every upgrade and every non-GET request checks `Host` against loopback names or configured origins, and checks `Origin` exactly (scheme, host, port). Cookies are `SameSite=Strict`, with no state change on GET. | B | A reusable ticket that leaks into a log can be replayed. Without an `Origin` check, any page in the person's browser, including another local port, can drive the server with their cookie. |
| R15 | P9 §12.2 | Cookie name with several servers on one loopback | `se_s_<first 12 of environment.id>`. The server ignores other names. | A | Every server reachable on `127.0.0.1` shares one cookie jar, so a fixed name lets servers clobber each other's sessions. |
| R16 | P9 §12.1 | Browsers on the tailnet listener | The phone lane keeps refusing any request with an `Origin`. Browser routes are a separate handler with the exact-origin rule from R14. | B | The phone's tailnet pairing is shipped. Its guarantee that no browser can speak on that lane must not weaken for the web client. |
| R17 | P9 §12.8 | The SDK in a browser; clients that cannot set headers | The SDK runs in a browser (no Node built-ins, WebSocket only) and accepts a ticket in the socket URL's query. A same-origin web tab authenticates by cookie. | A | Browsers cannot set headers on a WebSocket upgrade. A single-use, 30-second ticket in the query is spent before a log could be replayed. |
| R18 | P9-7 | Browser session lifetime | 30 days absolute, then the browser pairs again. Sessions are listed and revocable with devices. | A | A hard ceiling bounds what a stolen cookie is worth. A sliding window lets a session that is used often live for ever. |
| R19 | Q11; P9-1; P9 §12.3 | Web client off loopback | Tailnet web ships in phase 9 over HTTPS only, through `tailscale serve` with the listener kept on loopback. Never plain HTTP on a tailnet address. | B | Plain HTTP is not a secure context: `crypto.randomUUID`, the clipboard and notifications are missing, iOS refuses it, and the cookie cannot be `Secure`. |
| R20 | P9-2 | A Content-Security-Policy on the served web page | Yes, on the web page only (P9 §6.4). The desktop renderer stays without one. | B | Any site the person visits is one origin away from a web tab, and transcripts carry agent-written content. A `file://` window does not have that exposure. |

### SSH remotes

| ID | Spec IDs | Decision | Resolution | Class | Reason |
| --- | --- | --- | --- | --- | --- |
| R21 | P8-D1; P7 §12.6; §9.4, §10.2 step 3, §10.3 step 5 | SSH transport, and the WSL stdio fallback | One relay program carries bytes between stdio and the owner socket: the SSH connect session's stdio instead of `ssh -N -L` (P8 §5.4), and the WSL fallback's `wsl.exe` stdio (P7 §3.4). SSH adds a stream multiplexer; WSL uses one bridge per connection. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R22 | P8-D2 | Does a remote credential reach the desktop? | No. Each connect proves itself over the SSH session, and the desktop stores only the route, never a remote token. | A | A laptop's disk then holds no credential for any SSH machine. Revoking someone's SSH access revokes their Studio access. |
| R23 | P8-D3 | musl (Alpine) remotes | Refused in v1, with a sentence that names musl. | A | The pinned runtime and the bundle's native pieces have no musl builds, and finding that out from a loader ENOENT is worse than being told. |
| R24 | P8-D4 | glibc below the runtime's floor (RHEL/CentOS 7) | Refused with the version found. | A | Those systems are past end of life, and the pinned Node does not run there. |
| R25 | P8-D5 | Shared NFS homes | One server per home. A second host is refused with a clear message, and a per-host data directory needs an explicit `--data-dir`. | A | Automatic per-host directories split a person's chats without telling them. |
| R26 | P8-D6 | Remember SSH passwords or passphrases | No. A typed secret lives only for that connection attempt. People are pointed at `ssh-agent` and `ControlPersist`. | A | A stored password is a second copy of the person's SSH credential, held by an app that is not their SSH client. |
| R27 | P8-D7 | Install source on a remote | Stream the pinned Node and bundle from the desktop by default. Remote download of a digest-named release is a per-machine option. | B | Ruling (d): the same pinned-Node streaming serves SSH installs. Minimal images lack `curl` and `wget` (P8 E3), and streaming keeps one trust root. |
| R28 | P8-D9 | npm on the remote | The desktop's pure-JS npm ships in the bundle, so managed CLI installs work on remotes too. | B | Studio already installs agent CLIs for the person on the desktop and in WSL. Requiring hand installs on every remote would be a regression. One npm version runs everywhere. |
| R29 | P8-D10 | systemd user unit when lingering is on | Not without asking. A managed server is a detached process. A systemd or launchd unit is installed only when the person asks (`studio-server service install`, or a Settings switch). `loginctl enable-linger` is never run silently. | A | An app that installs a boot service on someone else's machine unasked surprises the machine's owner. Lingering is a host policy, not ours to infer. |
| R30 | P8-D11 | macOS remotes in v1 | Yes, arm64 and x64. A `launchd` agent only through R29. | A | P8's experiments ran the whole path on macOS without root. The pinned-Node runtime has builds for both architectures. |
| R31 | P8-D12 | Upgrading an older external server | Never automatic. The desktop names both versions and offers the in-place upgrade, which asks first and drains the same way. | A | An external server belongs to whoever started it, and it may serve other clients. |
| R32 | §10.3; P8 §6.4 | Managed remote server lifetime | Survives a dropped connection and the desktop quitting while an agent is running. Idles out after the last client leaves and no agent is running. | B | A laptop sleeping or roaming is the normal case for a remote. Stopping the server on disconnect would kill the agent the person left working. |
| R33 | Q8 | Remote targets | Linux x64/arm64 (glibc) and macOS in v1. No native Windows server over SSH; WSL is the Windows answer. | A | A Windows server would need a second process, path and shell model for a case WSL already covers. |
| R34 | Q4; P8-D8; §6.6 | CLI sign-in with no terminal | `providers.signIn` returns one of four interactions: a device code; a browser URL whose callback the desktop catches or whose final URL the person pastes back; credentials fields; or, for a CLI with none of those, a **sign-in-only terminal**. That terminal is a pty the server runs for exactly that CLI's login command, streamed in the sign-in dialog and closed when the command exits. | A | Works from every client (web, desktop, WSL, SSH), unlike a desktop-only `ssh -t`. It is the narrow exception the owner default allows, and ruling (a) holds because no general terminal exists. |

### WSL

| ID | Spec IDs | Decision | Resolution | Class | Reason |
| --- | --- | --- | --- | --- | --- |
| R35 | P7-D7; §10.2 step 3 | How Windows reaches a server in WSL | TCP first: the server binds the literal `127.0.0.1` inside the distribution, behind a bind guard, and Windows connects over localhost forwarding. The stdio bridge (R21) is the fallback, and a per-host setting can force it. Never a wildcard bind to reach the distribution's IP, and no tailnet listener in WSL. | B | Goal 4: in mirrored networking a wildcard bind puts the server on the PC's LAN. TCP also serves browser tabs and SDK scripts on Windows. The bridge covers a `.wslconfig` that turns forwarding off. |
| R36 | P7-D6; P7 §12.5; §10.2 step 4 | WSL server lifetime | Started on demand. The Windows side holds a lease (a live `wsl.exe` session) while a window shows that distro's workspace, a turn runs there, a subscription is open, or background mode is on. It drops the lease after 10 idle minutes. On quit it drains for up to 10 s, then drops it. Nothing relies on `setsid` to keep a server alive. | B | A WSL2 VM holds gigabytes of memory, so keeping it up for the whole app session because one chat once ran there costs the person's machine. WSL may stop an instance with no live session, so the lease is what keeps it up. |
| R65 | P7-D1; P7 §12.1, §12.7; §5.5 | Who reaches a WSL server, and who manages it | The Windows-side core is the front door. It starts and supervises each distro's server (`WslEnvironmentManager`) and routes that distro's conversation calls through a `ConversationBackend` seam extracted in phase 3, with local, remote and routed implementations. Electron main keeps only SSH, for its askpass dialogs. Clients reach WSL servers directly only with phase 8's environment list. | B | The phone's tailnet lane, module conversation services, scheduled agents and gateway tools call the runtime in process. Direct client connections would drop WSL chats from all of them. |
| R66 | P7 §12.4, §4.2; §9.1–9.2 | Loopback auth on a listener that could be squatted | Mutual proof. The client sends a nonce and no secret. The server answers with an HMAC proof over the owner token. Only then does the client prove itself, or present a ticket bound to that nonce. Renderers get `{ ticket, nonce, expectedProof }` from main. The same exchange runs over the bridge. | B | In NAT mode, another Windows process holding the port receives the connection, and Windows loopback is reachable from every session on the PC. A token sent in `hello` would be handed to an impostor. |
| R67 | P7 §12.2 | What the owner socket serves | The whole HTTP and WebSocket surface (upgrade, uploads, signed asset URLs), not frames only. | A | One listener that carries everything is what lets any byte pipe (the WSL bridge, the SSH relay, a forward) carry everything with no per-route special cases. |
| R68 | P7-D3; P7 §12.11; §7.1 | WSL data directory | One per Windows profile inside the distribution: `data/` for the packaged default profile, `data-<profileId>/` otherwise. Never shared with the Windows-side data directory. | A | A development build must never share chats with the installed app. Each side's database has one writer on its own file system. |
| R69 | P7-D5 | Provider API keys when a distro first moves to its server | Copied once, automatically, over the authenticated connection (`providers.secrets.set`), with a line in the migration notice. Later edits are offered, not pushed. Never through the environment or `WSLENV`. | A | Those keys already powered that distro's chats, and asking the person to type them again buys nothing. The environment of a WSL process can be read by any of the user's processes. |
| R70 | P7-D2 | WSL1 | WSL2 only. A WSL1 distro is refused with a message that names the conversion command (`wsl --set-version <distro> 2`); the new server never runs in one. | C, ruled | Owner ruling 2026-10-02. WSL1 lacks drive-mount inotify and its kernel is below Node 24's floor, and nobody the app serves uses it. |
| R71 | P7-D8 | The WSL helper and the server | Two processes in phase 7, merged in phase 10. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R72 | P7-D9 | Windows end-to-end testing | The manual checklist for the first release, and a self-hosted Windows runner with WSL2 before the default flips. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R73 | P7-D10 | `C:\` workspaces on a WSL machine | Keep supporting them: agents and git in WSL, UI file reads on Windows, and an advisory in New chat, never a block. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R74 | P7-D11 | The gateway-token gap in today's WSL chats | Fixed on `main` (#133 and follow-ups): a WSL chat is issued an MCP channel token per session, an ACP agent keeps its own, and the token is taken back when a start is refused. | A | Done. Nothing is left to decide. |
| R88 | P7 §1, §6; P7-D10 | Which machine a folder runs on, when the folder is on the other side of the Windows ↔ WSL line | The machine the person picks, in both directions: a `C:\` folder on WSL: <distro> runs there over `/mnt/c`, and a `\\wsl.localhost\<distro>\…` (or `\\wsl$\…`) folder on This PC runs on Windows with that folder as the agents' working directory, Studio's git there being Git for Windows with `-c safe.directory`. The folder's distribution is only the default when no machine is picked, which keeps every workspace made before machines on the machine it had. Only one distribution opening another's folder is refused, because it cannot. New chat says the cost in one line. | C, ruled | Owner ruling 2026-10-03: "why are we blocking people from doing that? That's a legitimate thing that someone might want to do. Yes, it'll be slower, but people have to get work done." Supersedes P7 §6's "a folder inside a distro always goes to that distro's server, whatever `hostId` says". |

### Rendering, the browser and the pane

Most of this section is superseded by the 2026-10-02 ruling: the server
renders nothing, so the questions about a server's Chromium, its sandbox,
fonts and frames are gone. What survives is about the desktop's own pane and
canvas, which are now the toolsets it offers.

| ID | Spec IDs | Decision | Resolution | Class | Reason |
| --- | --- | --- | --- | --- | --- |
| R37 | Q5; P5-D1; P6-D5, P6-O5 (browser); P7 §3.8, §12.10; P9 §3.6, §12.7 | The person's browser pane | The pane stays native on a desktop attached to a server on its own PC (the local server and its WSL servers), and agent `browser.*` tools act on it there. Everywhere else the pane is a screencast of the server's tabs. | Superseded (2026-10-02) | The server has no tabs to screencast. The pane is the desktop's native pane on every route and the desktop's `browser` toolset; an SSH server's tabs go through the SSH connection (R75, R76), and the web client gets previews (R77). |
| R38 | P5-D2; §8, §8.3 | The agents' browser profile model | One persistent profile per server, shared across its workspaces, which is today's model. Named and ephemeral profiles can come later. | Superseded (2026-10-02) | No server browser, so no server profile. The profile is the desktop's: today's shared persistent partition for its own PC, and one partition per SSH environment (R76). |
| R39 | P5 §5.3; P9 §12.7; P5c §10.1 | What counts as the person taking over | Pointer-down, key-down and wheel on the pane, and the person's own navigation commands, bump the tab's epoch. Agent navigations do not. Since 2026-10-02 this is a rule of the desktop's pane and its `browser` toolset, where the epoch already lives. | A | A person who clicks in a page an agent is driving has taken it over as surely as one who types. |
| R40 | P5-D3; Q6 | Which Chromium for WSL, SSH and standalone servers | `chrome-headless-shell`. | Superseded (2026-10-02) | No server downloads or runs a Chromium. |
| R41 | P5-D4; Q6 | Where the download comes from | The Chrome for Testing bucket, pinned by our own SHA-256. | Superseded (2026-10-02) | There is no download. |
| R42 | P5-D5; Q6; §8.2 | When the sandbox cannot start | Never fall back silently. A per-host `render.allowNoSandbox`, off by default, with a persistent warning. No implicit exception for the canvas. | Superseded (2026-10-02) | No browser runs on a server, so there is no sandbox to start. |
| R43 | P5-D10; Q6 | Who downloads Chromium for WSL and SSH hosts | The host when it can reach the bucket; the client streams it as the fallback. | Superseded (2026-10-02) | There is no download. |
| R44 | P5-D11; P5c §12 | A `browser.dialog` tool and a `dialog_open` error | Yes, as a change to the desktop's `browser` toolset. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R45 | P5 §1.2 finding 8 | Screencast frames on the wire | One binary message type for frames. Everything else stays JSON text. | Superseded (2026-10-02) | No screencast. Every client tool result fits one JSON frame (P5c §4.6), so the wire stays text only. |
| R46 | P5 §1.2 finding 3; P6-D5, P6-O5 (canvas); P7 §3.8, §12.10 | Where the canvas worker runs for servers on the desktop's own PC | The shell's existing offscreen worker, over `ShellBridge`, for the local server and its WSL servers. No `electron-child` render host, and no Linux Chromium download for WSL while a desktop is attached. Chromium for SSH and standalone servers. | Superseded (2026-10-02) | The canvas is always a client's: the desktop's worker draws for every server it is attached to, as the `canvas` toolset, and no server draws. |
| R47 | Q7; P5-D8 | Attached-client canvas fallback for SSH and standalone servers (parent §8.4) | Drop it. (WSL is covered by R46, not by this fallback.) | Superseded (2026-10-02) | What was a fallback is now the only path, and a general one (client toolsets). |
| R48 | P5-D6; P5c §12 | Bundle the Xiaolai CJK font | Yes, in the desktop and the web client, the two clients that draw boards. Not in the server, which draws nothing (2026-10-02). | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R49 | P5-D7 | Bundle an emoji font for the Linux canvas worker | Not in v1; the probe warns. | Superseded (2026-10-02) | There is no Linux canvas worker on a server; clients use their own emoji fonts. |
| R50 | P5-D9 | Split phase 5 | 5a (render host and canvas), 5b (agents' browser), 5c (the screencast view). After R37, 5c serves only non-local environments and the web. | Superseded (2026-10-02) | Phase 5 is now client tools, one phase (`phase-5-client-tools.md`). |
| R75 | P8-D13; P8 §6.8 | The local end of the SSH pane's forward | The forward's local end is an HTTP proxy bound to `127.0.0.1` on an ephemeral port with a per-session `Proxy-Authorization` credential, answered through Electron's `login` event. Open only while that environment has a pane tab. No SOCKS5 listener. | C, ruled | Owner ruling 2026-10-02. It keeps goal 4, never an unauthenticated port, on shared Macs and Windows PCs as well as Linux. |
| R76 | P8-D14; P8 §6.8; P5c §10.4 | The SSH pane's partition and what goes through the remote | One persistent partition per environment (`persist:env-<environment.id>`), shared by that environment's workspaces. All of its traffic goes through the remote, loopback included (`proxyBypassRules: '<-loopback>'`), with a per-machine switch to send only loopback there. | A | The proxy is set per session, so a partition cannot span environments; per environment matches today's shared model and keeps sign-ins across workspaces. Sending everything through the remote makes the pane see the network the agent sees (its `/etc/hosts`, its private network). |

### The web client

| ID | Spec IDs | Decision | Resolution | Class | Reason |
| --- | --- | --- | --- | --- | --- |
| R51 | P9-5 | Narrow layout for phone browsers | Yes, for the chat route: a drawer sidebar and a full-width chat below the medium breakpoint. | A | A phone on the tailnet opens the web URL as readily as the app, and chat is the surface people use there. |
| R52 | P9-6 | Monaco on the web | Loaded lazily. Heavy panels load on first open. | A | The chat route needs Monaco only for the checkpoint diff. |
| R53 | P9-9 | Account sign-in on the web | Offered, loaded lazily so a person who never signs in never downloads it. It returns through a URL route instead of the deep link. | A | Parity with the desktop costs nothing for people who do not use it. The route is the browser's equivalent of the deep link. |
| R54 | P9-10 | Keyboard chords browsers reserve | Web keymap defaults avoid reserved chords, by a client-kind condition in the keymap. A person can rebind them. | A | A shortcut a browser takes first is a shortcut that silently does not work. |
| R55 | P9-12 | Service worker | None in v1; a web manifest only. | A | Nothing works offline without the server, and a stale cached bundle against a newer server is a version-skew bug. |
| R56 | P9 §12.5 | Clipboard and `openExternal` | Client-side on every client, including a desktop attached to a remote server. | A | A remote server's clipboard and screen are not the person's. |
| R57 | P9 §12.11 | Client state on the web | `localStorage` per origin. One server reached by two routes keeps two sets of drafts, which is stated. | A | Origins are the browser's storage boundary. Syncing drafts through the server is a feature, not a fix. |
| R58 | P9-3 | Embed scope in v1 | Read-only. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R59 | P9-8; P9 §12.9 | Embed delivery and the `embeds` namespace | An iframe route and a React component in v1, and the web component later. The `embeds` namespace (`create`, `list`, `revoke`) and the embed `postMessage` wire get a row in `docs/compatibility.md`. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R77 | P9-13; P9 §3.6 | How the web client shows an agent's dev server | `previews`: a port on the server's loopback passed through on an origin of its own (same host, its own port), never Studio's. Its own single-use entry code and cookie; Studio's cookies stripped from what it forwards; WebSocket upgrades passed through. Offered ports are those the server's agent processes listen on, plus a port an owner types; never Studio's own. Owner sessions, or a `previews:open` grant that tailnet browsers do not get by default. | B | The dev app is agent-written code running in the person's browser. On Studio's origin it could read the session and drive the server; a separate origin makes Studio's exact `Origin` rule (R14) refuse it. |
| R79 | P9-14; P9 §3.8; P5c §7.2, §10.5 | Does the web client offer `canvas`, and from which sessions? | Yes, from a session holding the owner's grants, with `kind: 'web'`; never from a tailnet browser pairing in v1. It runs the same worker page and portable canvas service, keeping boards through `files.*`. | A | It runs the real editor in a real browser, so agents keep the canvas with only a web tab attached. Tailnet pairings never hold `tools:offer` in v1 (P5c §7.1). |

### Modules and migration

| ID | Spec IDs | Decision | Resolution | Class | Reason |
| --- | --- | --- | --- | --- | --- |
| R60 | Q10; P6-D10, P6-O12; P6 §12.3 | Third-party `entry.main` that imports `electron`; the module server/client split | An `electron-main` host capability, an optional `requires.hostCapabilities` manifest field, and a load-time `require('electron')` interceptor. No host API bump. Every module declares both halves in phase 10. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R61 | §11; P9-4 | Third-party renderer modules on the web; their asset origin | Off by default on the web, with a per-server owner switch. Bundled modules load. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R62 | P6-D7, P6-O6 | Phase 6's domain cut | Approve P6 section 5. Git panel, file explorer, skills, marketplace, tours, memory, PRs and design stay in the shell until phase 10. Since 2026-10-02 the canvas service is the shell's too (the `canvas` toolset); only the board files are server-owned. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R63 | P6-O13; P7 §12.9; §6.2 | Who writes the launcher pointer and integrations on the desktop | The shell, in phase 6. In a distro, the Windows side stays the one writer until terminals move. SSH and standalone servers write their own host's. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R64 | P6-O14 | Keep the phase 6 experiment scripts | Not kept. Experiments run from a scratch directory and are not committed. | C, ruled | Owner ruling 2026-10-02. No test needs them. |
| R78 | P6-D11, P6-O15; P5c §10.6 | The desktop's editor, tour and terminal tools once the server is out of process | The shell offers them as toolsets on phase 5's mechanism, over the control channel. Amended as built (2026-10-03): the shell offers six toolsets, `browser`, `canvas`, `editor`, `tour`, `terminal` (`terminal.list`, `terminal.create`) and `agent` (`agent.launch`, `agent.status`), because a tool's wire name is `<toolset>.<tool>` and one toolset cannot hold both `terminal.*` and `agent.launch`. `backlog.work` stays the server's, since an offer may never shadow a family the server registers, and it starts its terminal through `ShellBridge.terminals`. `ShellBridge` keeps only what is not an agent tool (cipher, internal terminal launches for `backlog.work`, scheduled runs, resume in terminal and two service tokens, reveal, notify, analytics, the integrations gate). | A | One path for every tool a client supplies, with one routing rule, one deadline and one cancellation, instead of bespoke bridge members that would repeat them. |

### Client tools (phase 5)

| ID | Spec IDs | Decision | Resolution | Class | Reason |
| --- | --- | --- | --- | --- | --- |
| R80 | P5c-1; P5c §10.3 | Where boards live | Where they are today: the server's data directory (`canvas/ws_<hash>/`) plus the legacy `diagrams/` folder, read and written through the owner-only `files.*`. Moving them into the workspace is a separate product question. | B | It moves nobody's files, needs no migration on any host, and keeps agent-drawn scratch boards out of commits, which is why boards left the checkout in the first place. |
| R81 | P5c-2; P5c §6.2 | Routing among several clients offering one toolset | Affinity first (a conversation stays on the client it first used), then the client the person is looking at, then the one showing the workspace, then the client that started the conversation, then desktop before web before headless. | A | The person watching is the one who can see and take over the browser; affinity keeps a tab, a worker's warm state and an app's session from hopping mid-task. |
| R82 | P5c-3; P5c §7.1 | Approve each app toolset on first offer, beyond the `tools:offer` scope | The scope given at pairing is the consent, with Settings showing every toolset, the audit, and an OS notification the first time an app offers a name. No separate prompt. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. |
| R83 | P5c-4 | Should the server answer `canvas.list`, `describe` and `find` itself with no client attached | No. With no client offering `canvas`, agents have no canvas tools. | A | Ruling (f) keeps the canvas off the server, and splitting one tool family across two owners would give agents two lists that disagree. |
| R84 | P5c-5; P5c §5.3 | Remove a client's tools mid-connection for runtimes that honour `list_changed` | No. A connection's list only grows; a tool whose client has gone answers `client_unavailable` until it is offered again. | B | Every runtime then behaves the same, prompt caches and Claude Code's ToolSearch index stay valid, and an agent reads a sentence naming the fix instead of an unknown-tool error. |
| R85 | P5c-6; P5c §4.5, §8.2 | Grace and timeout values | A 20 s reconnect grace, a 60 s default tool timeout and 600 s maximum. Log reconnect gaps and call durations, and revisit after a release. | A | They cover today's built-in deadlines and a network blip; the numbers are constants a later release can change without a protocol bump. |
| R86 | P5c-7; P5c §1.3 finding 2, §5.4 | Hand Codex and ACP chats the gateway at launch | Yes, in a separate change after phase 5: the gateway in Codex's `-c` overrides and in ACP's `session/new` and `session/load`, with the chat's identity on the entry, and never a second copy beside a pinned workspace entry. | C, ruled | Owner ruling 2026-10-02: the recommendation stands. Done after phase 5: every Codex and ACP chat, on this machine and in WSL, is handed the gateway under the pinned entry's id with its own R87 token (Codex passes it on by name from the app-server's environment; an ACP agent is told it on the entry, over stdin), and a branch of an ACP session is handed none. |
| R87 | Review of P5c §7 | How the gateway knows which conversation an agent connection belongs to | Each agent launch is issued its own gateway token bound to its conversation (the WSL channel token generalised to every launch), and the server derives the identity from the token, never from what the connection declares. Part of phase 5. | C, ruled | Owner ruling 2026-10-02. A declared identity is only a claim, so any local agent could otherwise reach tools an app offered to another conversation. |

Counts: 87 rows. 38 are class A, 20 class B and 18 class C, all 18 ruled by
the owner on 2026-10-02; 11 are superseded (2026-10-02).

## The browser pane and the render host

**Superseded (2026-10-02).** This section reconciled four specs that each put
a browser or a canvas renderer somewhere in the server's reach: a render host
with server-owned tabs, a screencast pane for SSH and the web, the shell's
worker drawing for servers on its own PC, and Chromium everywhere else. The
owner ruling of 2026-10-02 removed the premise: the server renders nothing.
The answer that replaces it:

1. **No server tabs.** Tabs live in the desktop's pane, as today. The agents'
   `browser.*` tools are the desktop's `browser` toolset, driven through its
   webview by `browser-control.ts`; the person-wins epoch stays there (R39).
2. **The pane is native on every route.** For the local server and its WSL
   servers its traffic goes direct (Windows reaches WSL's `localhost` by
   forwarding). For an SSH server it goes through the SSH connection, on a
   partition of that environment's own (R75, R76). No screencast anywhere.
3. **The web client** offers no `browser` toolset in v1 and shows an agent's
   dev server through `previews`, on an origin of its own (R77).
4. **The canvas** is a client's: the desktop's hidden worker window, and the
   web client's page, each offering the `canvas` toolset over board files the
   server keeps (phase 5 spec §10).

## Phase 7's changes to the parent, reconciled

| Phase 7 change | Resolution | Row |
| --- | --- | --- |
| §12.1 A `ConversationBackend` seam in phase 3 | Accepted. Extracted in phase 3 as a pure refactor, before phase 6 moves the core, so phases 7 and 8 route through it. A guard test forbids importing `ConversationRuntime` outside the backend modules. | R65 |
| §12.2 The owner socket serves the whole HTTP surface | Accepted. Phase 8's relay depends on it as well. | R67 |
| §12.3 The SDK takes a transport | Accepted, and merged with phase 6's transport seam. | R03 |
| §12.4 Loopback auth proves both ends | Accepted for every listener that could be squatted. Phase 9's single-use tickets become tickets bound to the handshake nonce. | R66, R14 |
| §12.5 No reliance on `setsid`; the lease | Accepted. | R36 |
| §12.6 The stdio fallback is a byte bridge | Accepted, with one relay program shared with SSH. Phase 8's multiplexer is SSH-only. | R21 |
| §12.7 WSL servers are managed by the Windows-side core | Accepted. This narrows phase 8 §12.4: main's connection broker serves SSH. A renderer that reaches a WSL server directly asks main, and main asks the core. | R65 |
| §12.8 `terminals` advertised to the desktop's own WSL servers | Accepted. It changes nothing in phase 7, because chats there route through the front door. | — |
| §12.9 One writer for the launcher pointer in a distro | Accepted, with the launcher-pointer decision. | R63 |
| §12.10 Desktop rendering for WSL before a Linux Chromium download | Superseded (2026-10-02): there is no Linux Chromium to prefer it over. The desktop's toolsets serve a WSL server as they serve the local one. | R37, R46 |
| §12.11 One data directory per Windows profile | Accepted. | R68 |
| §12.12 Phase 7 is size L | Accepted. | — |
| §12.13 Forwarded tools are client toolsets (added 2026-10-02) | Accepted. The front door offers the WSL server what its shell offers it, on phase 5's mechanism. | R78 |

## For the owner: the class C items

**Ruled (owner ruling 2026-10-02).** Every item below is decided as recommended,
with three exceptions: R64, the experiment scripts are not kept; R70, the new
server is WSL2 only and a WSL1 distro is refused with the conversion command;
R75, the SSH pane's local end is an HTTP proxy with a per-session credential,
not SOCKS5. R87 is added: every agent launch gets its own gateway token, and the
server takes the conversation from the token. The list keeps the reasoning as it
was put to the owner. The 2026-10-02 ruling removed the Chromium, sandbox, screencast and
server-canvas items (R37, R38, R40–R43, R45–R47, R49, R50), and R74 is fixed
on `main`.

1. **R21 Relay transport for SSH and the WSL fallback.** Use one relay program
   over stdio, not `ssh -N -L`. It needs no local listener and has no free-port
   race or 104-byte socket paths. It works where `sshd` forbids forwarding,
   costs one authentication per connect even on Windows OpenSSH, and is the
   same program as WSL's stdio bridge. It now also carries the SSH pane's
   forward (R75).
2. **R44 `browser.dialog`.** Yes, in the desktop's `browser` toolset. A page's
   `alert` in the pane otherwise blocks the agent until its deadline when
   nobody is watching.
3. **R48 Xiaolai font.** Bundle it (12 MB, OFL) in the desktop and the web
   client. CJK labels are then measured the same by every client that draws,
   and nothing fetches fonts from esm.sh, which the app does today.
4. **R58 Embed scope.** Read-only in v1. Acting from inside someone else's
   page needs its own threat model.
5. **R59 Embed delivery.** An iframe route and a React component in v1, the
   web component later, and the `embeds` namespace with its compatibility row.
6. **R60 `electron` modules and the module split.** The capability, the
   manifest field and the `require` interceptor, with no host API bump.
7. **R61 Third-party renderer modules on the web.** Off by default, with a
   per-server owner switch.
8. **R62 Phase 6 domain cut.** Approve P6 section 5 as written, with the
   canvas service on the shell's side and only the board files server-owned.
9. **R63 Launcher pointer.** The shell writes it on the desktop in phase 6,
   and the Windows side stays its one writer inside a distro.
10. **R64 Experiment scripts.** Keep them only if you want them. No test needs
    them.
11. **R70 WSL1.** Keep it on the per-process path. It has no drive-mount
    inotify, its kernel is below Node 24's floor, and it likely has few users.
    Removing the per-process path later means dropping WSL1 chats.
12. **R71 Helper and server.** Two processes in phase 7. Merge them when the
    Git pane and explorer move to the protocol.
13. **R72 Windows end-to-end testing.** The manual checklist for the first
    release, and a self-hosted WSL2 runner before the default flips.
14. **R73 `C:\` workspaces on a WSL machine.** Keep supporting them, with UI
    reads on Windows and an advisory in New chat. Never block them.
    Extended by R88 (owner ruling 2026-10-03): a folder inside a distribution
    runs on This PC when that is the machine picked, and is never blocked
    either.
15. **R75 The SSH pane's local proxy.** To show a remote machine's dev server
    in the desktop's own browser pane, the desktop runs a small proxy on the
    laptop that the pane talks to, and sends its traffic through the SSH
    connection. Chromium only talks to this kind of proxy (SOCKS5) without a
    password, so while it is open another user account on the same laptop
    could use it to reach the remote machine as you, against goal 4 ("never
    an unauthenticated port"). Recommended for now: keep SOCKS5 but narrowed,
    open only while a tab for that machine is open and, on Linux, refusing
    other users' connections. If shared Macs or Windows PCs matter, use an
    HTTP proxy with a per-session password instead, which Chromium does
    answer; nothing else in the design changes.
16. **R82 Consent for an app's tools.** When you pair an app and tick "Give
    agents tools from this app", that tick is the consent: no second prompt
    each time the app offers a toolset. You see every toolset in Settings, get
    a notification the first time an app offers one, and every call still
    passes the agent's own approval. Recommended: keep it to the pairing tick.
    A second prompt guards against nothing the pairing did not already allow,
    since the app runs as you.
17. **R86 Studio's tools in Codex, Cursor, OpenCode and Grok chats.** Today
    only Claude chats (and agents started in a terminal) are given Studio's
    tools: workspaces and backlog, the browser, the canvas, and any tools an
    app offers. A Codex or
    ACP chat gets them only by accident, from a config file a terminal launch
    left in the folder. Recommended: yes, give those chats the gateway too, in
    a small change after phase 5, so a chat can use the browser and the
    canvas whichever agent runs it. Ruled yes, and done: every chat is now
    given the gateway when it starts, under its own conversation.
