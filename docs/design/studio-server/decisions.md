# Studio server — decisions

Status: 2026-10-01. This file resolves the open decisions of
`docs/design/studio-server.md` (section 15) and of the phase specs beside it
(phase 5 section 11, phase 6 section 14, phase 7 section 11, phase 8 section
11, phase 9 section 13, and the changes each asks of the parent). Questions
that already have a settled answer are decided here. Only the rest go to the
owner (owner ruling 2026-10-01).

Where a row changes what a spec says, the spec is amended in the same change
that lands that phase's first commit, as each spec already requires.

## How to read the table

- **ID** is this file's row number. **Spec IDs** name where the question was
  asked: `Q5` is question 5 in the parent's section 15; `P5-D2`, `P6-O5`,
  `P7-D3`, `P8-D1` are the decision numbers in the phase 5–8 specs; `P9-3` is
  phase 9's owner decision 3; `§` points at a section of the named document.
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
| R13 | Q1; P9-11 | Package names | `@sprintengine/conversation-protocol` grows into the whole Studio wire: types and parsers only, with the phone's pinned files untouched. Client logic goes in separate packages: `@sprintengine/agent-sdk`, `@sprintengine/conversation-timeline` and `@sprintengine/conversation-view`. No rename before 1.0. | A | One wire package means one versioning policy and one import for third parties. Keeping client behaviour out of it keeps the phone's pin stable. A rename costs every early adopter a migration for a name. |
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
| R21 | P8-D1; P7 §12.6; §9.4, §10.2 step 3, §10.3 step 5 | SSH transport, and the WSL stdio fallback | One relay program carries bytes between stdio and the owner socket: the SSH connect session's stdio instead of `ssh -N -L` (P8 §5.4), and the WSL fallback's `wsl.exe` stdio (P7 §3.4). SSH adds a stream multiplexer; WSL uses one bridge per connection. | C | See the owner list. |
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
| R70 | P7-D2 | WSL1 | Keep WSL1 on the per-process path. | C | See the owner list. |
| R71 | P7-D8 | The WSL helper and the server | Two processes in phase 7, merged in phase 10. | C | See the owner list. |
| R72 | P7-D9 | Windows end-to-end testing | The manual checklist for the first release, and a self-hosted Windows runner with WSL2 before the default flips. | C | See the owner list. |
| R73 | P7-D10 | `C:\` workspaces on a WSL machine | Keep supporting them: agents and git in WSL, UI file reads on Windows, and an advisory in New chat, never a block. | C | See the owner list. |
| R74 | P7-D11 | The gateway-token gap in today's WSL chats | Fix it on `main` now: issue and revoke a channel token per chat session, and forward it. | C | See the owner list. |

### Rendering, the browser and the pane

| ID | Spec IDs | Decision | Resolution | Class | Reason |
| --- | --- | --- | --- | --- | --- |
| R37 | Q5; P5-D1; P6-D5, P6-O5 (browser); P7 §3.8, §12.10; P9 §3.6, §12.7 | The person's browser pane | The pane stays native on a desktop attached to a server on its own PC (the local server and its WSL servers), and agent `browser.*` tools act on it there. Everywhere else the pane is a screencast of the server's tabs. See "The browser pane and the render host" below. | A | Full native fidelity where the person usually works. Ruling (e)'s no-window browsing is still met on every server without a shell. |
| R38 | P5-D2; §8, §8.3 | The agents' browser profile model | One persistent profile per server, shared across its workspaces, which is today's model. Named and ephemeral profiles can come later. | A | Sign-ins survive restarts and idle parks. One process instead of one per workspace on small hosts. No change in behaviour on the desktop. |
| R39 | P5 §5.3; P9 §12.7 | What counts as the person taking over | Pointer-down, key-down and wheel on the pane, and the person's own navigation commands, bump the tab's epoch. Agent navigations do not. | A | When the pane is the person's only way in, a click is as much a takeover as a key. |
| R40 | P5-D3; Q6 | Which Chromium for WSL, SSH and standalone servers | `chrome-headless-shell`. | C | See the owner list. |
| R41 | P5-D4; Q6 | Where the download comes from | The Chrome for Testing bucket, pinned by our own SHA-256. | C | See the owner list. |
| R42 | P5-D5; Q6; §8.2 | When the sandbox cannot start | Never fall back silently. A per-host `render.allowNoSandbox`, off by default, with a persistent warning. No implicit exception for the canvas. | C | See the owner list. |
| R43 | P5-D10; Q6 | Who downloads Chromium for WSL and SSH hosts | The host when it can reach the bucket; the client streams it as the fallback. | C | See the owner list. |
| R44 | P5-D11 | A `browser.dialog` tool and a `dialog_open` error | Yes, in the agents'-browser phase. | C | See the owner list. |
| R45 | P5 §1.2 finding 8 | Screencast frames on the wire | One binary message type for frames. Everything else stays JSON text. | C | See the owner list. |
| R46 | P5 §1.2 finding 3; P6-D5, P6-O5 (canvas); P7 §3.8, §12.10 | Where the canvas worker runs for servers on the desktop's own PC | The shell's existing offscreen worker, over `ShellBridge`, for the local server and its WSL servers. No `electron-child` render host, and no Linux Chromium download for WSL while a desktop is attached. Chromium for SSH and standalone servers. | C | See the owner list. |
| R47 | Q7; P5-D8 | Attached-client canvas fallback for SSH and standalone servers (parent §8.4) | Drop it. (WSL is covered by R46, not by this fallback.) | C | See the owner list. |
| R48 | P5-D6 | Bundle the Xiaolai CJK font | Yes, in the server bundle and the desktop. | C | See the owner list. |
| R49 | P5-D7 | Bundle an emoji font for the Linux canvas worker | Not in v1; the probe warns. | C | See the owner list. |
| R50 | P5-D9 | Split phase 5 | 5a (render host and canvas), 5b (agents' browser), 5c (the screencast view). After R37, 5c serves only non-local environments and the web. | C | See the owner list. |

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
| R58 | P9-3 | Embed scope in v1 | Read-only. | C | See the owner list. |
| R59 | P9-8; P9 §12.9 | Embed delivery and the `embeds` namespace | An iframe route and a React component in v1, and the web component later. The `embeds` namespace (`create`, `list`, `revoke`) and the embed `postMessage` wire get a row in `docs/compatibility.md`. | C | See the owner list. |

### Modules and migration

| ID | Spec IDs | Decision | Resolution | Class | Reason |
| --- | --- | --- | --- | --- | --- |
| R60 | Q10; P6-D10, P6-O12; P6 §12.3 | Third-party `entry.main` that imports `electron`; the module server/client split | An `electron-main` host capability, an optional `requires.hostCapabilities` manifest field, and a load-time `require('electron')` interceptor. No host API bump. Every module declares both halves in phase 10. | C | See the owner list. |
| R61 | §11; P9-4 | Third-party renderer modules on the web; their asset origin | Off by default on the web, with a per-server owner switch. Bundled modules load. | C | See the owner list. |
| R62 | P6-D7, P6-O6 | Phase 6's domain cut | Approve P6 section 5. Git panel, file explorer, skills, marketplace, tours, memory, PRs and design stay in the shell until phase 10. | C | See the owner list. |
| R63 | P6-O13; P7 §12.9; §6.2 | Who writes the launcher pointer and integrations on the desktop | The shell, in phase 6. In a distro, the Windows side stays the one writer until terminals move. SSH and standalone servers write their own host's. | C | See the owner list. |
| R64 | P6-O14 | Keep the phase 6 experiment scripts | Optional, under `scripts/experiments/server-process/`. | C | See the owner list. |

Counts: 74 rows. 33 are class A, 17 class B and 24 class C.

## The browser pane and the render host

The specs disagree:

- Phase 6 keeps desktop rendering in the shell and uses headless Chromium only
  off the desktop (P6-O5).
- Phase 5 runs every render in a child process, Electron on desktops and
  Chromium elsewhere, and makes the pane a screencast (P5 §4.1, §5.7).
- Phase 7 has the attached Windows desktop render for WSL before any Linux
  Chromium is downloaded (P7 §3.8).
- Phase 9 makes the pane a screencast on every client (P9 §3.6).
- The earlier owner default made the pane a live view of the server's headless
  browser.

The one answer:

1. **One tab model.** Tabs belong to the server's `BrowserTabsService`
   (P5 §5.1): server-minted ids, grouped by workspace, persisted, with the
   person-wins epoch (R39). Tools reach a tab through `CdpSession`, which has
   two implementations: the Electron debugger on a shell tab, and a CDP target
   in the render host's Chromium.
2. **Where a tab renders depends on whether a desktop shell shares the
   server's PC.**
   - **The desktop's local server and its WSL servers.** Tabs render in the
     shell's native pane, in today's persistent partition. Agent `browser.*`
     calls reach them as client-directed calls: over `ShellBridge` (P6-O5) for
     the local server, and through the front door (R65) for a WSL server. A dev
     server an agent starts in WSL is reachable from the Windows pane through
     localhost forwarding, as it is today (P7 §3.8). These servers run
     only while the shell keeps them (R01, R36), so a shell is always there. With no window
     open (the tray), the shell keeps the workspace's tabs as offscreen web
     contents in the same partition, so no tool needs a window. Nothing is
     downloaded, and no `electron-child` render host is built.
   - **SSH and standalone servers.** Tabs render in the server's own Chromium
     (P5 §4.2–§4.5), one persistent profile per server (R38). This is ruling
     (e)'s headless mode. It is also correct for a remote chat, because the
     agent's dev server listens on the remote's `localhost` (P5 §5.6), which a
     pane on the laptop cannot reach.
   - **A WSL server with no desktop attached.** This cannot happen while the
     lease (R36) is the only thing that keeps it running. If a later phase lets
     one run on its own, it uses a Linux Chromium when present and working.
     Otherwise the tool answers that this server cannot render, and how to fix
     it (P7 §3.8).
3. **The pane is a view of wherever the tab renders.** On a desktop attached
   to a server on its own PC, the pane is the native `<webview>`. It keeps
   DevTools, file drag and drop, rich clipboard, inline PDFs and the password
   manager, so P5-D1's losses do not apply there. In every other case the pane
   is the `ScreencastView` (P5 §5.7, P9 §3.6): a desktop attached to an SSH or
   standalone server, and every web client. A web tab viewing a shell-hosted
   tab gets the same `browser.screencast` stream, produced by
   `Page.startScreencast` on that tab's debugger session. If phase 5c finds
   Electron's debugger refuses it, that one case shows "open this tab in the
   desktop app" instead.
4. **Canvas follows the same line** (R46, for the owner): the shell's worker
   for the local and WSL servers, and the Chromium canvas process for SSH and
   standalone servers.

What this changes in the specs:

- The earlier default, "the pane becomes a live view of the server's headless
  browser", now holds on every route except a desktop attached to a server on
  its own PC.
- P5's `electron-child` backend and its stdio control channel are dropped.
- 5c shrinks to the screencast view for SSH and standalone servers and for the
  web.
- The parent's §8 rule "client-directed when the workspace has an active pane
  tab" becomes "always the shell, for a server on the desktop's own PC".
- Phase 9 §12.7's removal of the client-directed path is withdrawn for those
  servers.
- Phase 7's "the attached desktop renders for WSL" (P7 §12.10) is kept, and
  extends from canvas to the agents' browser.

**Why this answer.** Most of the time the person works on a desktop attached to
a server on their own PC, and there a native pane is cheapest and most
faithful. A screencast earns its costs (JPEG text, no DevTools, no password
manager, in-app pickers) only where there is nothing native to show. Agents
still browse with no window open on every server, which is what ruling (e) asks.
There is one tab model and one tool code path, so the cases differ only in
which `CdpSession` a tab holds.

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
| §12.10 Desktop rendering for WSL before a Linux Chromium download | Accepted, and extended to the agents' browser (above). | R37, R46 |
| §12.11 One data directory per Windows profile | Accepted. | R68 |
| §12.12 Phase 7 is size L | Accepted. | — |

## For the owner: the class C items

Each item keeps its spec's recommendation as the working default until you
rule.

1. **R21 Relay transport for SSH and the WSL fallback.** Use one relay program
   over stdio, not `ssh -N -L`. It needs no local listener and has no free-port
   race or 104-byte socket paths. It works where `sshd` forbids forwarding,
   costs one authentication per connect even on Windows OpenSSH, and is the
   same program as WSL's stdio bridge.
2. **R40 Which Chromium.** `chrome-headless-shell`: half the download and a
   fraction of the memory, and no tool or canvas gap was found. Revisit if
   people browse PDFs on remote servers.
3. **R41 Download source.** The Chrome for Testing bucket with our own SHA-256
   pins. A mirror needs a legal review; our own build is a project.
4. **R42 No sandbox.** Never silently. `render.allowNoSandbox` per host, off by
   default, warned in `server.info`. It covers the canvas too.
5. **R43 Who downloads Chromium.** The host when it can reach the bucket, and
   the desktop streams it otherwise. This differs from R27, where the desktop
   streams by default under ruling (d). The reason is 100+ MB over SSH from a
   laptop. Say if you want R27's rule here as well.
6. **R44 `browser.dialog`.** Yes. With no person watching, a dialog otherwise
   blocks the agent until its deadline.
7. **R45 Binary screencast frames.** Yes, as one binary message type. Base64
   in JSON adds a third to every frame.
8. **R46 Canvas for the local and WSL servers.** The shell's existing offscreen
   worker over `ShellBridge`, matching R37's rule that the shell renders for
   servers on its own PC. No `electron-child` host, and no Linux Chromium
   download for WSL.
9. **R47 Attached-client canvas fallback for SSH and standalone servers.**
   Drop it. Only a headless host whose Chromium cannot start would use it, and
   the probe's fix is better than a second code path.
10. **R48 Xiaolai font.** Bundle it (12 MB, OFL). CJK labels are then measured
    the same everywhere, and nothing fetches fonts from esm.sh.
11. **R49 Emoji font.** Not in v1. The probe warns.
12. **R50 Phase 5 split.** Yes: 5a, 5b, and a smaller 5c.
13. **R58 Embed scope.** Read-only in v1. Acting from inside someone else's
    page needs its own threat model.
14. **R59 Embed delivery.** An iframe route and a React component in v1, the
    web component later, and the `embeds` namespace with its compatibility row.
15. **R60 `electron` modules and the module split.** The capability, the
    manifest field and the `require` interceptor, with no host API bump.
16. **R61 Third-party renderer modules on the web.** Off by default, with a
    per-server owner switch.
17. **R62 Phase 6 domain cut.** Approve P6 section 5 as written.
18. **R63 Launcher pointer.** The shell writes it on the desktop in phase 6,
    and the Windows side stays its one writer inside a distro.
19. **R64 Experiment scripts.** Keep them only if you want them. No test needs
    them.
20. **R70 WSL1.** Keep it on the per-process path. It has no drive-mount
    inotify and no Chromium sandbox, its kernel is below Node 24's floor, and it
    likely has few users. Removing the per-process path later means dropping
    WSL1 chats.
21. **R71 Helper and server.** Two processes in phase 7. Merge them when the
    Git pane and explorer move to the protocol.
22. **R72 Windows end-to-end testing.** The manual checklist for the first
    release, and a self-hosted WSL2 runner before the default flips.
23. **R73 `C:\` workspaces on a WSL machine.** Keep supporting them, with UI
    reads on Windows and an advisory in New chat. Never block them.
24. **R74 The WSL chat gateway-token gap.** Fix it on `main` now, independently
    of phase 7: issue and revoke a channel token per chat session, and forward
    it.

Not a class C item, but it narrows an earlier default: R37 keeps the native
pane on a desktop attached to a server on its own PC, and uses the screencast
everywhere else.
