# Phase 5 — headless rendering: scoping spec

Status: scoped, 2026-10-01. Nothing here is implemented. This file hardens
phase 5 of `docs/design/studio-server.md` (sections 6.7, 8 and 13) against the
code as it stands and against experiments run on 2026-10-01. Where it
disagrees with the parent design, section 1.2 says so and why; the parent is
amended in the same change that lands the first phase 5 commit.

## 1. Summary

The server gets a **render host**: Chromium processes it launches and drives
over the CDP pipe (`--remote-debugging-pipe`, never a TCP port). They do three
jobs:

1. **Canvas.** They run the existing canvas worker page
   (`src/renderer/canvas-worker.html`) with the real `@excalidraw/excalidraw`
   build, so `canvas.edit`, `layout`, `import` and `screenshot` (and board
   exports) work with no window and no client attached.
2. **The agents' browser.** The `browser.*` gateway tools drive tabs in the
   server's Chromium instead of `<webview>` guests in a desktop window.
3. **The person's browser pane.** The pane becomes a live view of those same
   tabs, a screencast with the person's input sent back (owner default,
   2026-10-01), on the desktop and on the web alike.

### 1.1 Owner defaults this spec applies (2026-10-01)

| Default | What it settles here |
| --- | --- |
| The browser pane becomes a live view of the server's headless browser | Open question 5 of the parent design is answered: one browser everywhere. The desktop's `<webview>` pane is retired at the end of the phase (5c). |
| Chromium is a pinned, hash-checked download on first use, with the sandbox on | Section 4.2. The sandbox is never turned off silently; where it cannot start, the host says why and how to fix it (4.4). |
| The server owns canvas data and the gateway tools; clients render | The canvas namespace (7.1); the worker runs on the server. |
| No terminals in v1 | The pane's "local servers" start page cannot list a terminal's dev servers on a remote server; it lists listening ports of the server's own agent processes instead (5.6). |

### 1.2 Findings that change the parent design

1. **"One Chromium per server" does not hold.** CDP browser contexts
   (`Target.createBrowserContext`) are in-memory only. Cookies and storage set
   in one are gone after a browser restart (experiment E6), and the render host
   idles out after five minutes. Per-workspace isolation *with* persistent
   sign-ins therefore needs **one Chromium process per workspace profile**
   (`--user-data-dir` each), plus one process for the canvas. Today the pane
   deliberately shares one persistent partition across all workspaces
   (`BROWSER_PARTITION` in `src/shared/browser.ts`), so isolation is a change
   in behaviour as well as in cost. This is decision D2.
2. **Electron cannot be driven like Chromium.** The app's own Electron binary
   accepts `--remote-debugging-pipe` and answers `Browser.getVersion`, but
   `Target.createTarget` answers "Not supported" and
   `Target.createBrowserContext` fails (E4). An Electron render host therefore
   needs its own small control channel over stdio to open and close windows,
   with `persist:` partitions per workspace. CDP then attaches to those windows.
   In return, one Electron process gives isolated *and* persistent profiles,
   which plain Chromium cannot do.
3. **Skip the in-process offscreen variant.** The parent plans an Electron
   offscreen `BrowserWindow` in main for phases 1–5, then a child process in
   phase 6. Both backends can be child processes speaking CDP over a pipe from
   day one: the Electron child on desktops, and Chromium for standalone, WSL and
   SSH servers. There is then one code path, and phase 6 has nothing to move.
4. **The canvas needs its own process, not just its own context.** It needs
   flags the agents' browser should not have: all network refused at the
   resolver as well as by `Fetch`, and font hinting off (finding 5). It also
   fails independently, and it is the only process for which a no-sandbox
   exception has even been discussed (D5).
5. **Text metrics differ between hosts unless hinting is off.** On Linux the
   same Excalifont and Nunito labels measured 205 / 182 / 42 px, against
   204.42 / 183.34 / 41.46 on macOS. With `--font-render-hinting=none` they
   match macOS exactly (E3). Those widths are written into the board file, so
   this flag is required, not cosmetic.
6. **The worker reaches the internet today.** For CJK text, Excalidraw's font
   loader falls back to `https://esm.sh/@excalidraw/excalidraw@0.18.1/…/Xiaolai`
   because the build skips the Xiaolai family (E3). The Electron worker has
   network access, so it does fetch them today. The server's canvas process
   refuses that request, so CJK is measured in a system font unless Xiaolai is
   bundled (D6).
7. **Screencast flow control is not strict.** Chromium keeps about three frames
   unacknowledged: with every ack delayed 200 ms the stream still ran at 14 fps
   (E5). "Ack only after the client drained it" lowers the rate but does not
   bound the queue. The server must keep only the latest frame per viewer and
   drop superseded ones.
8. **Frames want binary WebSocket messages.** A 1280×720 JPEG at quality 60 is
   18–23 KB; base64 inside JSON adds a third. The protocol (parent 5.1) is
   JSON text only, and `websocket-frames.ts` refuses binary opcodes. This spec
   proposes one binary message type for screencast frames (7.2).
9. **Phase 5 is three phases.** With the pane becoming a screencast, the scope
   is the render host and canvas (5a), the agents' browser on it (5b), and the
   pane as a view (5c). Each is shippable on its own; the commit plan (11) is
   cut along those lines.
10. **No SHA-256 is published for Chrome for Testing archives.** The bucket
    serves only MD5 and CRC32C headers. We compute and pin our own SHA-256 per
    archive in CI (4.2).

## 2. Where things stand

### 2.1 Canvas worker

- `src/main/canvas/canvas-worker-window.ts`: a hidden, **not offscreen**
  `BrowserWindow` (1280×800, `show:false`, `paintWhenInitiallyHidden`,
  `backgroundThrottling:false`, `sandbox:false`) that loads
  `out/renderer/canvas-worker.html` with the **full app preload**. IPC channels
  `canvas-worker:ready`, `:request` and `:response`, each checked against the
  sender. `READY_TIMEOUT_MS = 30_000`.
- `src/main/canvas/canvas-worker-host.ts`: `CanvasWorkerTransport`
  (`ensureStarted`, `post`, `onResponse`, `onCrashed`, `report`, `stop`). One
  request at a time; deadline 20 s (mermaid 60 s) plus a 15 s cold-start
  grace; two attempts with a restart in between; idle stop after 5 minutes.
  Error codes `timeout` and `worker_unavailable`. **This interface is already
  transport-neutral and is kept unchanged.**
- `src/shared/canvas/worker-protocol.ts`: five request kinds (`apply-edit`,
  `layout`, `import-mermaid`, `import-scene`, `export-image`). All five need the
  editor package's DOM-backed code, so the parent's "four of five" is five.
- The page: `src/renderer/src/canvasWorker/main.tsx`, `transport.ts` (the only
  file that knows IPC; it attaches only when `window.api.onCanvasWorkerRequest`
  and `canvasWorkerReady` exist), `bootstrap.tsx` (mounts one editor and waits
  up to 15 s for Excalifont, Nunito and Comic Shanns), `libraryBridge.ts`
  (`convertToExcalidrawElements`, `restoreElements`, `exportToBlob`; lazy
  `@excalidraw/mermaid-to-excalidraw`). Fonts come from `out/renderer/fonts/`,
  emitted by `canvasSceneFontsPlugin` in `electron.vite.config.ts`, with Xiaolai
  skipped. `canvasAssetPath.ts` sets `EXCALIDRAW_ASSET_PATH` to the page's own
  directory.
- `canvas-service.ts` screenshot ladder: PNG, then JPEG 0.8, then JPEG at 0.75×
  the edge, else `too_large`. Edge 64–1600 (default 1024), PNG budget 600 KiB,
  JPEG budget 900 KiB of base64, all inside the 1 MiB socket line.
- `exportBoard` writes PNG/SVG **rendered by the pane** (`CanvasEditor.tsx`
  uses `exportToSvg`). There is no worker operation for SVG.
- `canvas-subscribers.ts` maps WebContents ids to WebContents for scene and
  presence pushes.

### 2.2 The browser pane and the `browser.*` tools

- Tabs are `<webview>` guests (`BrowserTab.tsx`) on one machine-wide persistent
  partition, `persist:sprintengine-browser`, adopted by main through
  `browser:register` (`browser-manager.ts`, 1,052 lines). `guest-policy.ts`
  forces sandboxing and admits only the element-picker guest preload
  (`src/preload/browser-guest.ts`, which needs `contextIsolation:false` to read
  React fibers).
- `browser-control.ts` (957 lines) drives a guest through `wc.debugger` (CDP
  1.3): `Runtime.enable/evaluate`, `Log.enable`, `Network.enable
  {maxPostDataSize:0}`, `Page.enable`, `Input.dispatchMouseEvent`,
  `Input.dispatchKeyEvent`, `Input.insertText`, and in the manager
  `Emulation.setEmulatedMedia`. Screenshots use `wc.capturePage()` (JPEG 80,
  longest edge 1024), not CDP. It refuses to act while DevTools is open.
- Console: 200 entries, text ≤ 2,000 chars, `level/text/location/at`. Network:
  200 entries, `requestId/method/url(≤500)/status/outcome/errorText/
  resourceType/at`, with no headers, bodies or timings. Both buffers are
  cleared on a main-frame navigation, and capture starts only at the first tool
  call on a tab.
- Snapshot: a page-world DOM walker (`SNAPSHOT_SCRIPT`), not the CDP
  accessibility tree. It is capped at 400 nodes and 24,000 chars, and stores its
  refs on `window.__seBrowserRefs`.
- Person-wins: `epoch` bumps on the person's keyDown (from `before-input-event`
  while no agent input is in flight) and on `navigate/back/forward/reload/stop`.
  Agent navigations go through the same calls, so they bump it too. An agent
  `act()` that sees the epoch move returns `interrupted`. Mouse input does not
  bump the epoch today.
- Tool resolution (`browser-tools.ts`, 725 lines): a named `tabId`, then the
  agent's sticky assignment, then the person's active tab. `browser.open` with
  no tab broadcasts `browser:open-request` and waits 8 s for a window showing
  that workspace, else `pane_unavailable`. Every other tool answers `no_tab`.
  **With no window, an agent cannot browse at all.**
- Not handled anywhere today: downloads, certificate errors, HTTP auth,
  `beforeunload`, JavaScript dialogs, file choosers and find-in-page. Popups
  opened with `new-window` disposition become unregistered native windows that
  the tools cannot see.
- The IPC surface (`browser-ipc.ts`, preload `api/browser.ts`): 18 invoke
  channels (navigation, zoom, colour scheme, DevTools, separate window, clear
  cookies and cache, capture, copy screenshot, open external, local servers)
  and 6 pushes (`browser:state`, `open-request`, `viewport-request`, `pointer`,
  `focus-url`, `host-key`).
- `browser.resize` is not CDP emulation. The renderer CSS-scales the
  `<webview>` (`BrowserTab.tsx`), with 17 presets clamped to 240–3840 px.

### 2.3 Design previews and HTML artifacts

Neither is rendered in main. Design previews are sandboxed `srcDoc` iframes
(`PreviewFrame.tsx`, never `allow-scripts`). HTML artifacts are `srcDoc` iframes
(`HtmlArtifactFrame.tsx`, `HtmlPreviewCard.tsx`). Nothing captures either to an
image. **They need nothing from phase 5**: they are client renderings of
server data. The parent's "Previews render in the same host" applies only if a
future tool needs a preview image, and none does today. This spec drops it from
phase 5.

## 3. Experiments

All were run on 2026-10-01 on an arm64 Mac (macOS 26), and in Docker on an arm64
Ubuntu 24.04 VM kernel with `kernel.apparmor_restrict_unprivileged_userns=1`.
The scripts use a dependency-free CDP-over-pipe client (about 60 lines: NUL-
delimited JSON on fds 3 and 4). Neither Puppeteer nor Playwright is a dependency
of this repository, and none is needed. Memory figures are RSS summed over the
browser's process tree, which overcounts shared pages; read them as upper
bounds for comparison, not as budgets.

Engines: chrome-headless-shell 153.0.8010.12 (macOS arm64) and 154.0.8037.92
(Linux arm64, Chrome for Testing); Google Chrome 154 in `--headless=new`;
Electron 44.4.5 (Chromium 152), launched as a child with a 10-line entry.

### E1 — launch, isolation and the events the tools need

| | headless shell (mac) | Chrome `--headless=new` | headless shell (Linux, container) |
| --- | --- | --- | --- |
| Pipe up to `Browser.getVersion` | 315 ms cold, 65–74 ms warm | 260–790 ms | 37–215 ms |
| Idle RSS | 234 MB, 4 procs | 1,098 MB, 9 procs | 369 MB, 7 procs |
| 5 tabs, 2 contexts | 644 MB | 1,968 MB | 791 MB |
| 15 tabs | 1,460 MB | 3,211 MB | 1,681 MB |
| TCP listeners owned by the browser | none | none | none |

Verified on all three: cookies set in one context are invisible in another;
`Runtime.consoleAPICalled` and `Network.requestWillBeSent` arrive as today's
buffers expect; `Page.javascriptDialogOpening` fires for `confirm()` and
`Page.handleJavaScriptDialog` clears it; `Page.setInterceptFileChooserDialog`
yields `Page.fileChooserOpened`; `window.open` produces a `page` target with an
`openerId`; `Browser.setDownloadBehavior {behavior:'deny', eventsEnabled}` still
reports `Browser.downloadWillBegin` with the file name; `Page.crash` produces
`Inspector.targetCrashed` while the browser stays up. `Browser.close` returned
in 29–115 ms. Simple pages cost about 80–90 MB per tab.

In new headless, `Target.createTarget` refuses `width`/`height` unless
`newWindow: true`. A tab that is not in front stops producing animation frames
until `Page.bringToFront` (0 fps before, 60 fps after). The shell has no such
notion.

### E2 — download size

Chrome for Testing 154.0.8037.92, `Content-Length` of each archive:

| Archive | linux64 | linux-arm64 | mac-arm64 | mac-x64 | win64 |
| --- | --- | --- | --- | --- | --- |
| chrome-headless-shell | 120.5 MB | 121.2 MB | 99.2 MB | 104.7 MB | 120.8 MB |
| chrome (full) | 196.2 MB | 196.5 MB | 191.2 MB | — | — |

The linux-arm64 shell unpacks to 267 MB and contains no setuid sandbox helper.
It downloaded in about 5 s on this link. Its SHA-256 (computed here, for the pin
table) is
`0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6`. The bucket
publishes `x-goog-hash` MD5 and CRC32C only. Linux arm64 builds now exist for
both flavours, so ARM SSH hosts are covered.

### E3 — the real canvas worker page under CDP

The worker page built by `electron-vite build` was served from a loopback
origin. A `window.api` shim was injected with
`Page.addScriptToEvaluateOnNewDocument` and bridged by `Runtime.addBinding`. **No
change to the page was needed.** A request is one `Runtime.evaluate`; a reply is
one binding call. Everything outside the page's origin was refused with
`Fetch.failRequest`.

| | Electron 44 hidden window | shell 153 (mac) | Chrome 154 new headless (mac) | shell 154 (Linux, no extra fonts) | shell 154 (Linux, Noto fonts) | same, `--font-render-hinting=none` |
| --- | --- | --- | --- | --- | --- | --- |
| Page ready, fonts in | 108 ms | 91–94 ms | 128 ms | 323 ms | 314 ms | 311 ms |
| Font report | 3 loaded, 0 missing | same | same | same | same | same |
| `apply-edit` (5 shapes, labels, arrow) | 11 ms | 10–27 ms | 12 ms | 15 ms | 23 ms | 22 ms |
| `export-image` PNG 1024 edge, first / warm | 420 / 170 ms | 13–26 / 39 ms | 201 / 164 ms | 38 / 89 ms | 41 / 90 ms | 39 / 78 ms |
| `import-mermaid` flowchart | 57 ms | 48–57 ms | 55 ms | 183 ms | 157 ms | — |
| Label widths Excalifont / Nunito / "calls" | 204.42 / 183.34 / 41.46 | same | same | **205 / 182 / 42** | **205 / 182 / 42** | 204.42 / 183.34 / 41.46 |
| Emoji + CJK text width | 302.84 | 302.84 | 302.84 | **233** (tofu) | 306 | 306.09 |
| External requests refused | 4 × esm.sh Xiaolai | same | same | same | same | same |

- Export images had identical dimensions (1024×746) everywhere. The PNG bytes
  differed every time: 1.2–2.9 % of pixels differ, and 0.75–1.6 % by more than a
  quarter of full scale. Rough.js strokes and anti-aliasing account for it.
  **A pixel-hash test across engines cannot work** (section 9).
- An embedded image element (a `files` data URL) rendered in every engine.
- A mermaid `pie` came back as one `image` element, as the parent expects.
- Without emoji and CJK fonts on the host, both render as boxes, and the boxes'
  width is what the worker writes into the board.

### E4 — Electron as the render host

The app's Electron binary was launched with `--remote-debugging-pipe` and a
minimal entry:

- `Browser.getVersion` answered in 140–260 ms. Idle RSS was 209 MB (3 procs).
- `Target.getTargets` lists the windows the entry creates, and
  `Target.attachToTarget {flatten:true}` works on them.
- `Target.createTarget` answers "Not supported", and
  `Target.createBrowserContext` answers "Failed to create browser context".
- On an attached window, `Page.startScreencast` gave 60 fps with
  `offscreen:true` and 98 fps on a hidden window with
  `backgroundThrottling:false`. `Page.captureScreenshot` worked on both.

### E5 — screencast

The test page was a 1280×720 canvas animating every frame, with JPEG frames.

| Setting | mac shell | Linux shell | Chrome new headless |
| --- | --- | --- | --- |
| q60, every frame | 60 fps, 18 KB/frame, 9.0 Mbit/s | 60 fps, 23 KB, 11.4 Mbit/s | 60 fps, 19 KB, 9.2 Mbit/s |
| q80, every frame | 60 fps, 24 KB, 11.9 Mbit/s | 60 fps, 30 KB, 14.9 Mbit/s | 60 fps, 24 KB, 12.0 Mbit/s |
| q60, `everyNthFrame: 2` | 30 fps, 4.5 Mbit/s | 30 fps, 5.6 Mbit/s | 30 fps, 4.6 Mbit/s |
| Static page | 0.5 fps, 0.02 Mbit/s | 0.5 fps, 0.01 Mbit/s | 0.5 fps |
| Every ack delayed 200 ms | 14 fps | 14 fps | 14 fps |

Frames come only when something paints, so an idle page costs almost nothing.
A typical page is far cheaper than this worst case. With the 200 ms delay,
14 fps means roughly three frames in flight (finding 7).

### E6 — persistence

A cookie (`Max-Age` one day) and a `localStorage` key were written, the browser
closed, and the same `--user-data-dir` relaunched:

| | headless shell | Chrome new headless |
| --- | --- | --- |
| Default context | both survived | both survived |
| A `Target.createBrowserContext` context | both gone | both gone |

### E7 — Linux hosts and the sandbox

- **Libraries.** On `node:22-slim` (Debian 12), `ldd` reports 20 missing:
  `libX11 libXcomposite libXdamage libXext libXfixes libXrandr libasound
  libatk-1.0 libatspi libdbus-1 libexpat libgbm libgio-2.0 libglib-2.0
  libgobject-2.0 libnspr4 libnss3 libnssutil3 libxcb libxkbcommon`. The binary
  exits 127 on the first one. The headless shell links X11 libraries even
  though it never opens a display. `libgtk` and `libcups` are not needed.
- **As root.** The browser refuses to start without `--no-sandbox`.
- **Docker's default profile, as an ordinary user.** "No usable sandbox!" Its
  message names the Ubuntu 23.10+ AppArmor restriction.
- **`--security-opt seccomp=unconfined`.** The sandbox starts.
- **`seccomp=unconfined` and `apparmor=unconfined` on an Ubuntu 24.04 kernel.**
  "No usable sandbox!" again. An unconfined process on such a host may not
  create user namespaces, and a server started from an SSH login is exactly
  that. **A downloaded Chromium cannot start its sandbox on a stock Ubuntu
  24.04 host without a one-time change made as root.**
- **Fonts.** With only the library packages installed, emoji and CJK render as
  boxes. `fonts-noto-color-emoji` and `fonts-noto-cjk` fix both.
- **WSL2 was not tested.** Its kernel does not enforce AppArmor by default, so
  the sandbox is expected to start there. Phase 5 checks this on a real
  distribution (section 9.4).

### E8 — what a person sees through a screencast

A native `<select>` was clicked through `Input.dispatchMouseEvent`. Its popup
appears in neither the screencast nor `Page.captureScreenshot`, in either
headless flavour. ArrowDown then Enter did not change the value either. The
same holds for date, time and colour pickers, which are browser widgets rather
than page content. The pane has to draw these itself (5.7).

## 4. The render host

### 4.1 Process model

```
 RenderHost (server)
  ├─ canvas process          one per server; offline; ephemeral profile;
  │                          one page: the canvas worker
  └─ browser processes       one per workspace profile (D2), launched on
       ├─ ws_<hash>          first use; persistent profile directory;
       └─ ws_<hash>          tabs = CDP page targets in its default context
```

Two backends implement the same `RenderBackend` interface (section 6):

| Backend | Used by | Profiles | Opening a page |
| --- | --- | --- | --- |
| `electron-child` | the desktop, for its local server (macOS, Windows, Linux desktop) | one process; a `persist:ws_<hash>` partition per workspace, and an in-memory partition for the canvas | a JSON line on the child's stdin (`openPage { partition, url, offscreen }`), answered with the `targetId`; then `Target.attachToTarget` over the pipe |
| `chromium` | standalone, WSL and SSH servers | one process per profile (`--user-data-dir`) | `Target.createTarget` in the default context |

On the `electron-child` backend the canvas and workspace "processes" are
partitions inside one Electron process. The pool logic in 4.5 applies to
profiles, whichever backend holds them.

**Electron child entry.** The packaged app loads only its own asar, so the
render host is a mode of the app's main entry rather than a separate script.
`app-main.ts` checks for `--sprintengine-render-host` before anything else,
and in that mode it:

- takes no single-instance lock and opens no windows, tray or menu;
- calls `app.dock.hide()` before `ready`;
- reads control lines on stdin and answers on stdout;
- creates every page as an offscreen `BrowserWindow`
  (`webPreferences: { offscreen: true, sandbox: true, contextIsolation: true,
  nodeIntegration: false, backgroundThrottling: false, partition }`, no
  preload);
- exits when stdin closes.

Partition names are the server's choice. The app's own
`persist:sprintengine-browser` is never used, so the pane's existing sign-ins
are not reachable by agents through the child. (Whether to import them is
decision D2.)

### 4.2 Where the Chromium comes from (`chromium` backend)

In order, per server. The first that passes the probe (4.4) wins.

1. **A path the owner set** (`render.chromiumPath` in launch settings).
2. **A system browser**, probed at the usual locations: `google-chrome`,
   `google-chrome-stable`, `chromium` and `chromium-browser` on `PATH`;
   `/opt/google/chrome/chrome`; `/Applications/Google Chrome.app/…` on macOS.
   A snap-packaged `chromium` is skipped because its confinement hides
   `<dataDir>`. A distribution-packaged Chrome is preferred over the download
   on Ubuntu 23.10+ because it installs its own AppArmor profile, so its
   sandbox works (E7).
3. **The pinned download.** Chrome for Testing `chrome-headless-shell` (D3),
   from Google's bucket (D4), installed into
   `${XDG_DATA_HOME:-~/.local/share}/sprintengine-studio/runtime/chromium-<version>/`.
   On macOS it goes to `<dataDir>/../runtime/…`.

**The pin manifest.** `src/server/render/chromium-pins.ts`, generated by
`scripts/pin-chromium.mjs`:

```ts
export const CHROMIUM_PIN = {
  version: '154.0.8037.92',
  flavour: 'chrome-headless-shell',
  archives: {
    'linux-x64':   { url, sha256, bytes },
    'linux-arm64': { url, sha256: '0ed0e47d…091df6', bytes: 121182296 },
    'darwin-arm64': { url, sha256, bytes },
    'darwin-x64':  { url, sha256, bytes },
  },
} as const
```

The script reads the stable channel from the Chrome for Testing JSON endpoint,
downloads each archive, computes the SHA-256 and writes the file. CI reruns it
in check mode and fails if a pinned URL no longer serves those bytes. A
scheduled job opens a bump when the stable channel moves. A pin older than the
app's release by more than one stable milestone is flagged in `server.info`,
because a pinned browser stops getting security fixes.

**Install.** Download to `runtime/.staging-<random>` and verify the size and
SHA-256 while streaming. Unzip with a pure-JS unzip; `unzip` may be missing on
minimal hosts, so it is never relied on. Then `chmod +x` the binary, write
`.sprintengine-digest`, `mv -T` into place under `flock` on
`runtime/.chromium.lock`, and prune versions no running server references. This
is the `wsl-install.ts` sequence. A failed digest deletes the staging directory
and reports `render.unavailable { reason: 'digest_mismatch' }`. It never
retries into the same path.

**Who downloads.** The owner default is "on first use". For a server that can
reach `storage.googleapis.com`, the server downloads it, with progress on the
`notifications` stream and in `server.info`. Over 100 MB on a slow uplink from
the desktop is worse than the host's own network. Only when the host cannot
reach the bucket does the desktop download, verify and stream the archive over
the WSL or SSH channel as the parent's 8.1 describes (D10). Either way the
first canvas or browser call waits on the download, bounded at 10 minutes, and
the tool answers `render_unavailable` with "downloading Chromium (n %)"
instead of hanging past its own deadline.

### 4.3 Launch flags

Every process gets:

```
--remote-debugging-pipe --user-data-dir=<profile>
--no-first-run --no-default-browser-check --disable-background-networking
--disable-component-update --disable-sync --disable-default-apps
--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider
--metrics-recording-only --password-store=basic --use-mock-keychain
--mute-audio --font-render-hinting=none --disk-cache-size=67108864
--headless            (shell; `--headless=new` for a full Chrome)
```

The canvas process adds:

- `--host-resolver-rules="MAP * ~NOTFOUND"`, so it reaches nothing at the
  resolver;
- `--proxy-server=none`;
- the worker page served by `Fetch.fulfillRequest` from an origin that never
  resolves (4.6).

Never passed: `--remote-debugging-port`, `--remote-allow-origins`,
`--no-sandbox` (except under D5), `--enable-automation` (it sets
`navigator.webdriver`), `--disable-web-security`, and
`--allow-file-access-from-files`.

The user agent is set with `Network.setUserAgentOverride` per page. It uses
the browser's own UA with `HeadlessChrome` respelled `Chrome`, plus matching
`userAgentMetadata` brands. Today's pane strips `Electron/` from its UA for the
same reason: a UA naming an automation shell trips sites' bot checks.

### 4.4 The host probe

`probeRenderHost()` runs before the first launch and on demand from Settings:

| Check | How | Report |
| --- | --- | --- |
| Libraries | `ldd <binary>` and parse `=> not found`; the 20-library list from E7 maps to package names for `apt` (Debian/Ubuntu, including the `t64` names on 24.04) and `dnf` | "Missing: libnss3, libgbm1, … Run: `sudo apt-get install …`" |
| glibc | `ldd --version`; Chrome for Testing needs glibc ≥ 2.25 (from its `deb.deps`); musl (Alpine) is refused | "This host uses musl; install a distribution Chromium or run the server in a glibc distribution" |
| Sandbox | launch with `--headless about:blank` and a 10 s budget; classify stderr: "Running as root without --no-sandbox", "No usable sandbox" and its AppArmor/userns cause, from `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`, `/proc/sys/user/max_user_namespaces` and `/proc/self/status` `Seccomp:` | the cause and the fix for that cause (below) |
| Fonts | `fc-list : family` | missing emoji (`Noto Color Emoji`) and CJK (`Noto * CJK`) families, with the package line; a warning, not a failure |

Fixes the probe offers for "No usable sandbox":

- **Ubuntu 23.10+ AppArmor.** A one-time root command that installs
  `/etc/apparmor.d/sprintengine-chromium` and loads it. The profile is
  `abi <abi/4.0>, include <tunables/global>, profile sprintengine-chromium
  <runtime>/chromium-*/chrome-headless-shell flags=(unconfined) { userns,
  include if exists <local/sprintengine-chromium> }`, which is the remedy
  Chromium's own AppArmor documentation gives. Alternatively, install
  distribution Chrome.
- **A container.** Run it with `--security-opt seccomp=unconfined` (E7), or set
  `render.allowNoSandbox` for this host (D5).
- **Root.** Run the server as an ordinary user.

### 4.5 Lifecycle and limits

- **Launch on demand.** A process starts on the first `acquire` for its
  profile, and the canvas process can also be warmed when a board is opened.
  Readiness is `Browser.getVersion` answering within 15 s.
- **Idle.** The canvas process stops after 5 minutes with no requests (today's
  `CANVAS_WORKER_IDLE_MS`). A workspace browser process stops after 15 minutes
  with no screencast viewer, no agent call and no page loading. Its tabs are
  **parked**: the server keeps each tab's id, URL, title and viewport, and
  reopens the URL when the tab is next viewed or acted on. Form state on a
  parked tab is lost, which `browser.status` reports as `parked: true`.
- **Pool cap.** At most 4 workspace browser processes run at once (a setting,
  2–12). Acquiring a fifth parks the least recently used one that has no
  viewer and no agent call in flight. If none qualifies, the call answers
  `busy` with `retryAfterMs`.
- **Tabs.** At most 8 per workspace and 24 per server. 24 is today's
  `MAX_PANE_TABS`. Popups count toward the cap.
- **Memory ceiling.** Every 30 s the tree's RSS is sampled (`/proc/<pid>/
  status` on Linux, `ps` elsewhere, reusing `child-process-metrics.ts`). A
  process over 2 GB (a setting) is restarted, and its tabs are parked with the
  reason.
- **Renderer crash.** `Inspector.targetCrashed` (verified in E1) marks the tab
  `crashed`. The pane shows the error page, and the next agent call answers
  `cdp` with "the page crashed; navigate or reload to recover". The process
  stays up.
- **Process crash.** On pipe EOF or exit, every lease fails its in-flight calls
  with `worker_unavailable` (canvas) or `cdp` (browser). The process is
  relaunched once on the next acquire. A second crash within 60 s puts that
  profile in `failed` for 5 minutes, with the stderr tail in `server.info`.
  The canvas worker host's existing two-attempt rule runs on top, unchanged.
- **Shutdown.** `Browser.close` with a 3 s budget, then SIGKILL of the process
  group. The server places each Chromium in its own process group so that no
  orphan survives.

### 4.6 The canvas worker over CDP

`createCdpCanvasWorkerTransport({ host })` implements the existing
`CanvasWorkerTransport`. `canvas-worker-host.ts` is not touched.

1. **`ensureStarted`.** Acquire the canvas profile and open one page. Install
   the bridge before navigating:
   `Runtime.addBinding('__sprintengineCanvasReady')`,
   `Runtime.addBinding('__sprintengineCanvasRespond')`, and
   `Page.addScriptToEvaluateOnNewDocument` with the shim

   ```js
   window.api = {
     onCanvasWorkerRequest(cb) { window.__sprintengineCanvasRequest = cb; return () => {} },
     canvasWorkerReady(r) { __sprintengineCanvasReady(JSON.stringify(r)) },
     canvasWorkerRespond(r) { __sprintengineCanvasRespond(JSON.stringify(r)) },
   }
   ```

   Then navigate to `https://canvas-worker.sprintengine.invalid/canvas-worker.html`.
   `Fetch.enable { patterns: [{ urlPattern: '*' }] }` serves that origin from
   the worker directory in the server bundle (`Fetch.fulfillRequest` with the
   file bytes and MIME type) and fails everything else with `BlockedByClient`.
   `.invalid` never resolves, no listener is opened, and the page needs no
   change (E3). Resolve when the ready binding fires; reject after
   `READY_TIMEOUT_MS`.
2. **`post`.** `Runtime.evaluate { expression:
   'window.__sprintengineCanvasRequest(' + JSON.stringify(req) + ')' }`. A board
   with large embedded images can make this expression several MB.
   `Runtime.evaluate` has no practical size limit over a pipe, but a request
   above 32 MB is answered `too_large` before it is sent.
3. **`onResponse`.** Fed from `Runtime.bindingCalled`, filtered to this
   session.
4. **`onCrashed`.** Fires on `Inspector.targetCrashed`, `Target.detachedFromTarget`,
   pipe EOF, or `Page.frameNavigated` away from the worker URL.
5. **`report`.** Returns the ready payload, as today.
6. **`stop`.** Closes the page, and the lease lets the process idle out.

On the desktop, during phase 5a, the Electron worker window
(`canvas-worker-window.ts`) stays as the transport behind a setting
(`render.canvasTransport: 'window' | 'render-host'`). The setting defaults to
`render-host` once the 5a tests are green, and the window transport is deleted
one release later.

**New worker operation: `export-svg`.** The request and success shapes follow
`export-image`, returning `{ svg: string, width, height }`, produced with
`exportToSvg` in `libraryBridge.ts`. `canvas.exportImage` on the protocol (7.1)
and `exportBoard` on a server with no pane use it. The pane keeps rendering
its own exports when it is the one asking.

**Fonts.**

- `--font-render-hinting=none` (finding 5).
- Xiaolai is bundled for the server's worker if D6 says so, and
  `EXCALIDRAW_ASSET_PATH` keeps pointing at the page's own directory. The
  canvas process then never asks esm.sh.
- The probe's font warning is included in `CanvasWorkerReport.errors`, so
  `fontWarning()` puts it on every write, as it does today for a missing
  family. Its text: "this host has no emoji/CJK fonts; text containing them is
  measured in a fallback face".

### 4.7 Security

- **No debugging port.** CDP runs over fds 3 and 4 only (E1: no TCP
  listener). A test asserts this on every CI platform (9.3).
- **Profiles** live under `<dataDir>/render/profiles/<profileId>/` (0700).
  They are never the person's own browser profile, and never
  `persist:sprintengine-browser` (D2 decides any import).
- **The canvas process is offline** at two layers: the resolver map and
  `Fetch`.
- **Navigation policy for agent and person tabs.** Only `http:`, `https:` and
  `about:blank` are allowed, as `will-navigate` enforces today, through
  `Fetch.requestPaused` on documents and `Page.frameRequestedNavigation`.
  `file:`, `chrome:`, `devtools:`, `view-source:`, `data:` documents and
  `javascript:` URLs are refused.
- **The server's own listeners are refused** to the agents' browser: its
  loopback port, the tailnet listener's address and port, and
  `/.well-known/sprintengine-studio`. They are already authenticated, but a
  page an agent opens must not even reach them. `localhost` dev servers on
  other ports stay reachable; that is the point of the pane.
- **Permissions.** `Browser.setPermission` per page origin: grant
  `clipboard-sanitized-write`; deny notifications, geolocation, camera,
  microphone, MIDI, USB, HID and serial. This is today's allow-list minus
  geolocation and notifications, neither of which means anything on a server.
  `clipboard-read` is not needed, because paste is bridged by the pane (5.7).
- **Downloads** are denied by default (`eventsEnabled` so they are reported).
  See 5.5.
- **Input from a client** needs `browser:operate`. Watching needs
  `browser:read`. Neither scope is granted to an existing tailnet pairing (the
  legacy-scope rule in parent 9.4).
- **`browser.evaluate`** stays a mutation tool. It runs in the page's world, as
  today.
- **The audit log** records `browser.input` as one entry per gesture (pointer
  down, key down), never per mouse move, and never with typed text, the same
  rule as `browser.type`.

## 5. The agents' browser and the pane

### 5.1 Server-owned tabs

`BrowserTabsService` (`src/server/browser/browser-tabs-service.ts`) replaces
the main-process `browser-manager.ts` as the owner of tabs:

- Tabs belong to the server, keyed by a server-minted `tabId`, grouped by
  workspace, and persisted to `<dataDir>/render/tabs.json` (id, workspace, URL,
  title, viewport, colour scheme, order). They survive an app restart, a client
  disconnect and an idle park.
- The person's "active tab" becomes per client: each viewer tells the server
  which tab it shows (`browser.focus`). `activeTab(workspaceId)` returns the tab
  most recently focused by any viewer of that workspace, else the first tab.
  This is today's `activeTabByWorkspace` without the window.
- `requestOpen` no longer needs a window. `browser.open` with no tab **creates
  one** and returns it after the load settles. `pane_unavailable` is no longer
  answered. An attached desktop or web client that advertises `reveal-tab` is
  sent a `call` to show it, if it shows that workspace. That reveal is
  best-effort and never blocks the tool.
- `BrowserTabState` keeps its shape (`describeTab` is unchanged) and gains
  `parked`, `crashed`, `popupOf`, `dialog`, `fileChooser` and `download`
  fields.

### 5.2 `CdpSession` under `browser-control.ts`

`browser-control.ts` keeps its logic: the act/epoch/interrupted machine, the
snapshot walker, key chords, buffers and caps. It changes in three places:

- `BrowserControlManager.webContentsOf(tabId)` becomes
  `sessionOf(tabId): CdpSession | null` (interface in section 6).
- `wc.debugger.sendCommand` becomes `session.send`, and
  `debugger.on('message')` becomes `session.on`.
- `capturePage()` becomes
  `Page.captureScreenshot { format: 'jpeg', quality: 80 }`, with the longest
  edge capped at 1024. The scale is computed from `Page.getLayoutMetrics`, and
  `clip.scale` is set to it, so the result keeps today's `SCREENSHOT_MAX_EDGE`.

The "refuse while DevTools is open" rule goes, because there is no DevTools in
the server browser (D1). The attach-once enable order (`Runtime`, `Log`,
`Network {maxPostDataSize:0}`, `Page`) moves to session creation. **Capture
starts when the tab opens, not at the first tool call**, which fixes today's
gap where console errors before the first call are lost.

The Electron `wc.debugger` implementation of `CdpSession` lives on in
`src/main/browser/` only until 5c removes the `<webview>` pane.

### 5.3 Person-wins on the server

The epoch bumps on:

- the person's pointer-down, key-down or wheel arriving on `browser.input` (not
  pointer moves);
- the person's navigation commands from the pane (`browser.navigate`, back,
  forward, reload, stop).

**Agent navigations no longer bump it.** Today they do, because both paths
share one manager call. The service tags each command with its origin instead.
Pointer-down is new: today a person's click does not interrupt an agent, which
is surprising when the pane is the person's only way in. `CONTROLLER_LINGER_MS`
and the history coalescing stay.

### 5.4 Behaviours the tools need, today and on the server

| Behaviour | Today (`<webview>`) | On the render host |
| --- | --- | --- |
| Tab when no window is open | none; `pane_unavailable` / `no_tab` | `browser.open` creates one; other tools still answer `no_tab` until one exists |
| Snapshot, refs, click, hover, type, press, scroll, evaluate, wait_for | `wc.debugger` | same CDP over `CdpSession`; byte-identical scripts |
| Screenshot | `capturePage`, JPEG 80, ≤1024 | `Page.captureScreenshot`, JPEG 80, ≤1024 |
| Console / network | 200-entry buffers from the first call | same buffers and fields, from tab creation |
| `resize` | renderer CSS-scales the `<webview>` | `Emulation.setDeviceMetricsOverride` (width, height, DPR 1 or the preset's, `mobile` for phone presets) + `Emulation.setTouchEmulationEnabled` for touch presets; the viewers' frames follow |
| `set_appearance` | `Emulation.setEmulatedMedia`, reapplied on navigation | same; `system` follows the focusing viewer's scheme, else light |
| Zoom | `setZoomFactor` | the pane's `Emulation.setPageScaleFactor`; zoom no longer changes the viewport the page sees |
| Popups | `new-window` → unregistered native window; `_blank` → in place | every `Target.targetCreated` with an `openerId` becomes a tab with `popupOf`, visible to tools and the pane; `window.close()` closes it; OAuth flows work |
| JS dialogs | Electron default; likely stalls `evaluate` to its 30 s deadline (not tested) | `Page.javascriptDialogOpening` sets `tab.dialog`; the pane shows it; agent actions answer `dialog_open` with the message; `browser.dialog {accept, promptText}` answers it (D11); `beforeunload` is auto-accepted for agent navigations |
| File chooser | native dialog in the person's OS | intercepted (E1): the pane offers the person's own file picker, uploads the bytes, then `DOM.setFileInputFiles` with the server-side paths; an agent gets `file_chooser_open` (an upload tool is later) |
| Downloads | Electron default (a save dialog) | denied and reported; the pane offers "Allow downloads for this tab", which switches to `allowAndName` into `<dataDir>/render/downloads/<workspace>/` (0700) and serves the file to the client over HTTP |
| HTTP auth | Electron default | `Fetch.authRequired` (with `handleAuthRequests`) → the pane asks; with no viewer, cancelled |
| Certificate errors | Electron default (refused) | refused; the error page names the error; no override in v1 |
| Element picker | guest preload reading React fibers | `Overlay.setInspectMode` + `Overlay.inspectNodeRequested`, then the same fiber read via `Runtime.callFunctionOn` on the node; no preload, no `contextIsolation:false` |
| DevTools | detached DevTools window | none in v1 (D1); the pane gains a Console and Network drawer over the same buffers the tools read |
| Local servers start page | `ps` + `lsof` under the workspace's terminal pty subtrees | the same scan under the server's agent and module sidecar process subtrees; terminals exist only on the desktop (ruling a), so the desktop also merges its own terminals' list when the server is on its own machine |
| Clear cookies / cache | whole shared partition | `Storage.clearDataForOrigin` per origin, or the whole profile (the workspace's) |
| Open in separate window, open external | `BrowserWindow`, `shell.openExternal` | "Open in your browser" stays a client action with the tab's URL; the separate window is a second pane view of the same tab |

### 5.5 What the agents' browser may write

Downloads and uploads write under `<dataDir>/render/` only:

- downloads go to `render/downloads/<workspace>/`;
- uploads go to `render/uploads/<random>/` and are removed when the tab
  navigates or closes.

Neither is ever inside the workspace checkout. That keeps an agent from
dropping a downloaded file into the repository through the browser. An agent
that wants a file in the workspace fetches it with its own tools.

### 5.6 Local servers on a remote server

The start page lists `http://localhost:<port>` for every TCP listener owned by
a process under one of the server's agent or sidecar subtrees. It reuses
`parseListeningSockets` and `descendantPids` from `browser-manager.ts`, moved to
`src/server/browser/`. On a remote server, "localhost" in the pane is the
server's localhost, which is where the agents' dev servers run. That is the
correct target, and it is the first time a remote chat's agent can show its
running app to the person.

### 5.7 The pane as a screencast view (5c)

`ScreencastView` (`src/renderer/src/components/workspace/pane/browser/
ScreencastView.tsx`) replaces the `<webview>` in `BrowserTab.tsx`. The toolbar,
device toolbar, start page, error page and agent cursor overlay are kept.

**Frames.** The pane subscribes to `browser.screencast { tabId, maxWidth,
maxHeight, dpr, quality, maxFps }`:

- `maxWidth` and `maxHeight` are the pane's CSS size × `devicePixelRatio`,
  capped at 2560 on the long edge.
- The server sets `Emulation.setDeviceMetricsOverride` to the pane's CSS size
  and `deviceScaleFactor: dpr`, unless an agent `resize` or the device toolbar
  set a viewport. Then the frame is letterboxed, as today's CSS scaling does.
- Defaults: JPEG quality 70 and 30 fps (`everyNthFrame: 2`) on loopback and
  the owner socket; quality 60 and 15 fps over the tailnet. A client may ask
  for up to 60 fps.
- Frames are drawn with `createImageBitmap` into a `<canvas>`.

**Fan-out and flow control** (finding 7). The server holds one CDP screencast
per tab, however many viewers there are:

- It acks each frame upstream as soon as it arrives.
- It keeps a single latest-frame slot per viewer. A frame is sent to a viewer
  only when that viewer's socket write buffer is below 256 KB; otherwise the
  slot is overwritten.
- A viewer that has not drained in 10 s is sent a `subFailed { code:
  'slow_consumer', retryable: true }`.
- The screencast stops 5 s after the last viewer leaves.

A slow phone never slows the desktop's view.

**Input.** The pane maps DOM events to `browser.input` batches, coalescing
pointer moves to one per animation frame:

- pointer → `Input.dispatchMouseEvent` (move, down, up, wheel; buttons,
  `clickCount`, modifiers), with coordinates divided by the view's scale;
- touch → `Input.dispatchTouchEvent` when a touch preset is active;
- keys → `Input.dispatchKeyEvent`, reusing `parseKeyChord`'s key table, with
  `text` for printable keys. Composition (IME) → `Input.imeSetComposition`
  while composing, then `Input.insertText` on commit;
- the chords the pane handles itself (today's `browser:host-key` table:
  ⌘L, ⌘R and the app's own) are never sent.

**Pickers** (E8). On `pointerdown` over a `<select>`, `<input type=date|time|
datetime-local|month|week|color>` or `<datalist>` input:

- The server resolves the element at the point with `DOM.getNodeForLocation`,
  reads its options or value, and pushes a `picker` event.
- The pane draws an in-app menu or picker anchored at the element's box.
- The choice is applied with `Runtime.callFunctionOn`, which sets
  `value`/`selectedIndex` and dispatches `input` and `change`.
- The default action is suppressed, so the invisible native popup never opens.
- Agents are unaffected: they already use `browser.type` and `evaluate` for
  these elements.

**Clipboard.**

- **Copy (⌘C/⌘X).** The key is dispatched, then the pane asks
  `browser.selection` (a `Runtime.evaluate` of `getSelection().toString()`, or
  the focused input's selected range) and writes it to the client clipboard.
- **Paste (⌘V).** The pane reads its own clipboard (a user gesture, so allowed)
  and sends `Input.insertText`. Rich and image paste are not supported in v1.

**Cursor and focus.** A `cursor` event, from the page's computed cursor at the
pointer and sampled on move at most every 100 ms, sets the view's CSS cursor.
Focus and blur of the view are sent as `Emulation.setFocusEmulationEnabled`, so
the page's `:focus` and caret behave.

**What the person loses against the native pane** (accepted under D1):

- DevTools;
- extensions, which never existed in the pane;
- drag and drop of files into the page (v1 shows "use the file picker");
- rich clipboard;
- spell-check suggestions in context menus. Context menus are an in-app menu
  with Back, Forward, Reload, Copy, Paste and Copy link;
- PDFs rendered inline, if D3 picks the shell;
- smooth scrolling and text rendering at full native fidelity, because frames
  are JPEG;
- the password manager and autofill.

Pinch zoom maps to `Emulation.setPageScaleFactor`.

## 6. Interfaces

```ts
// src/server/render/cdp.ts — the one CDP client, transport-neutral.
export interface CdpConnection {
  send<M extends CdpMethod>(method: M, params?: CdpParams<M>, sessionId?: string): Promise<CdpResult<M>>
  on<E extends CdpEvent>(event: E, cb: (params: CdpEventParams<E>, sessionId?: string) => void): () => void
  readonly closed: Promise<{ reason: 'eof' | 'exit' | 'disposed'; detail?: string }>
  dispose(): void
}
export function connectPipe(child: ChildProcess /* stdio[3] write, stdio[4] read */): CdpConnection

export interface CdpSession {
  readonly targetId: string
  send<M extends CdpMethod>(method: M, params?: CdpParams<M>): Promise<CdpResult<M>>
  on<E extends CdpEvent>(event: E, cb: (params: CdpEventParams<E>) => void): () => void
  /** Resolves when the target goes away, with why. */
  readonly ended: Promise<{ reason: 'closed' | 'crashed' | 'browser-exit' | 'detached' }>
  detach(): Promise<void>
}

// src/server/render/render-host.ts
export type RenderProfileSpec =
  | { kind: 'canvas' }
  | { kind: 'workspace'; workspaceId: string }

export interface RenderHost {
  status(): RenderHostStatus
  onStatus(cb: (s: RenderHostStatus) => void): () => void
  /** Starts (or reuses) the profile's process; refuses with RenderUnavailable. */
  acquire(spec: RenderProfileSpec): Promise<RenderLease>
  probe(): Promise<RenderProbeReport>
  dispose(): Promise<void>
}

export interface RenderLease {
  readonly profileId: string
  openPage(opts: { url: string; viewport?: Viewport; offline?: boolean }): Promise<RenderPage>
  pages(): RenderPage[]
  /** Pages the page itself opened (window.open), already attached. */
  onPopup(cb: (page: RenderPage, openerTargetId: string) => void): () => void
  release(): void
}

export interface RenderPage extends CdpSession {
  close(): Promise<void>
}

export interface RenderBackend {
  readonly kind: 'electron-child' | 'chromium'
  launch(profile: { id: string; dir: string | null; offline: boolean }): Promise<RenderProcess>
}
export interface RenderProcess {
  readonly pid: number
  readonly cdp: CdpConnection
  /** Electron: stdin control line; Chromium: Target.createTarget. */
  createPage(opts: { url: string; partition?: string }): Promise<{ targetId: string }>
  close(): Promise<void>
}

export type RenderHostStatus = {
  state: 'idle' | 'downloading' | 'running' | 'unavailable'
  backend: 'electron-child' | 'chromium' | null
  source: { kind: 'setting' | 'system' | 'pinned' | 'electron'; path: string; version: string } | null
  skipped: Array<{ kind: 'setting' | 'system' | 'pinned'; reason: string }>
  download?: { bytes: number; total: number }
  unavailable?: { code: RenderUnavailableCode; message: string; fix?: string }
  processes: Array<{ profileId: string; pid: number; rssMb: number; pages: number; idleForMs: number }>
}

export type RenderUnavailableCode =
  | 'missing_libraries' | 'no_sandbox' | 'musl' | 'download_declined'
  | 'download_failed' | 'digest_mismatch' | 'launch_failed' | 'crash_loop'

export type RenderProbeReport = {
  binary: string | null
  missingLibraries: Array<{ soname: string; aptPackage?: string; dnfPackage?: string }>
  glibc: string | null
  sandbox: { ok: true } | { ok: false; cause: 'root' | 'apparmor_userns' | 'seccomp' | 'userns_disabled' | 'unknown'; detail: string }
  fonts: { emoji: boolean; cjk: boolean }
}
```

The CDP types come from the `devtools-protocol` package, as a dev dependency
used for types only. It is not in `node_modules` today, so adding it is the
first commit of 5a. `CdpMethod` and the related aliases are mapped types over
`ProtocolMapping`.

`src/server/` imports none of `electron` (the parent's guard test). The
`electron-child` backend is server code that spawns a binary; it does not
import Electron.

## 7. Protocol additions

### 7.1 `canvas` namespace (scopes `canvas:read`, `canvas:operate`)

| Method / stream | Scope | Shape |
| --- | --- | --- |
| `canvas.list { workspaceId }` | read | `{ boards: [{ name, revision, updatedAt }] }` |
| `canvas.open { workspaceId, board }` | operate | creates if missing; `{ board }` |
| stream `canvas.board { workspaceId, board }` | read | snapshot `{ revision, elements, appState, files }` (chunked when large), then `scene { revision, elements? , changedIds }` and `presence` events; `canvas-subscribers.ts` becomes subscription id → stream |
| `canvas.commitScene { workspaceId, board, baseRevision, elements, files, commandId }` | operate | the existing per-element merge; `{ revision, conflicts }` |
| `canvas.exportImage { workspaceId, board, format: 'png'\|'svg', elementIds?, maxEdge?, dark?, background? }` | read | rendered by the worker (`export-image` / `export-svg`); `{ url }`, a signed HTTP path valid for 60 s |

### 7.2 `browser` namespace (scopes `browser:read`, `browser:operate`)

| Method / stream | Scope | Shape |
| --- | --- | --- |
| stream `browser.tabs { workspaceId }` | read | snapshot of `BrowserTabState[]`, then `state` events (today's `browser:state` push) and `pointer` events (today's `browser:pointer`, for the agent cursor) |
| `browser.focus { tabId }` | read | marks the tab this viewer shows |
| `browser.open { workspaceId, url?, afterTabId? }`, `browser.close { tabId }` | operate | person's tab management |
| `browser.navigate { tabId, url \| action }`, `browser.setViewport`, `browser.setColorScheme`, `browser.zoom` | operate | the toolbar; bumps the epoch |
| stream `browser.screencast { tabId, maxWidth, maxHeight, dpr, quality?, maxFps? }` | read | **binary** frame messages (below), then JSON `meta` (`deviceWidth`, `deviceHeight`, `pageScaleFactor`, `scrollOffsetX/Y`), `cursor`, `picker` events |
| `browser.input { tabId, events: InputEvent[] }` | operate | pointer, wheel, key, ime, touch; bumps the epoch on down and key events |
| `browser.selection { tabId }` | read | for copy |
| `browser.pick { tabId, choice }` | operate | answers a `picker` event |
| `browser.dialog.respond { tabId, accept, promptText? }`, `browser.fileChooser.respond { tabId, uploadIds }`, `browser.auth.respond { tabId, username?, password?, cancel? }` | operate | person answers |
| `browser.downloads { workspaceId }`, `browser.allowDownloads { tabId }` | read / operate | list, and serve over HTTP |

**Binary frames.** One WebSocket binary message per frame:

```
u8 kind = 1 | u32 sub id | u32 seq | u16 width | u16 height | JPEG bytes
```

This is the protocol's only binary message, and `websocket-frames.ts` gains
binary support for it alone. A client that did not advertise
`screencast-binary` in `hello` gets the same frames as JSON with base64 data.
The SDK prefers binary.

Capabilities in `welcome`:

- `render-host`: the server can render at all;
- `canvas-render`: the worker is available;
- `browser-headless`: agents can browse;
- `browser-screencast`: viewers can watch;
- `render-download-pending`: Chromium is still downloading.

## 8. Parity checklist (gate for flipping each default)

- [ ] Every `browser-tools.test.ts` case passes against the render-host
      session.
- [ ] Every `browser-control.test.ts` case passes against both `CdpSession`
      kinds.
- [ ] Console and network entries carry the same fields, caps and
      navigation reset.
- [ ] Interrupts: the person's key-down, pointer-down and toolbar navigation
      interrupt an in-flight agent action.
- [ ] Agent navigations do not interrupt the agent's own actions.
- [ ] The agent cursor overlay follows `pointer` events.
- [ ] `browser.open` with no client attached returns a tab.
- [ ] The canvas service suite passes with the CDP transport.
- [ ] Label widths for the three warmed families equal the Electron worker's
      on macOS and on Linux with hinting off.
- [ ] Screenshot dimensions equal the Electron worker's.
- [ ] Mermaid flowchart and pie fixtures import.
- [ ] Select, date and colour pickers work through the pane.
- [ ] A dialog, an OAuth popup, a file upload and a download complete through
      the pane.
- [ ] Copy and paste work.
- [ ] IME composition works.
- [ ] Sign-ins survive an idle park and an app restart (under D2's model).

## 9. Test strategy

### 9.1 Unit (always run, no browser)

- `cdp.test.ts`: the pipe framing (split and coalesced NUL frames, a 10 MB
  message), id correlation, events routed by `sessionId`, EOF failing pending
  calls, and a write after exit not throwing (E7 hit an unhandled EPIPE).
- `render-host.test.ts` with a fake backend:
  - lazy launch;
  - the pool cap and LRU park;
  - the idle timers for canvas and workspace;
  - crash-once relaunch and the crash-loop `failed` state;
  - the memory ceiling restart;
  - shutdown escalation to SIGKILL;
  - status transitions.
- `chromium-source.test.ts`: the source chain order, the snap skip, and the
  pin manifest's shape.
- The download and verify path against a local HTTP fixture: a size mismatch,
  a digest mismatch, a concurrent install under `flock`, and pruning.
- `render-probe.test.ts`: `ldd` output fixtures (the E7 list verbatim) mapped
  to apt (`t64` names on 24.04) and dnf packages; stderr fixtures for root,
  AppArmor userns, seccomp and success; `fc-list` fixtures.
- `cdp-canvas-transport.test.ts` against a fake `CdpConnection`: the bridge
  install order, ready, request and response correlation, crash on
  `targetCrashed`, `detachedFromTarget` and `frameNavigated`, and the
  `too_large` guard. `canvas-worker-host.test.ts` runs unchanged.
- `browser-control.test.ts` is parameterised over a fake `CdpSession`. The
  existing `FakeDebugger` becomes one implementation of it.
- `browser-tabs-service.test.ts`:
  - tab persistence and park/unpark;
  - popups as tabs;
  - dialog, file chooser, download and auth state;
  - epoch origins (agent navigation does not bump);
  - the active tab per viewer;
  - the navigation and origin deny-list.
- Screencast fan-out with fake sockets: the latest-frame slot, a slow consumer
  not slowing a fast one, the stop after the last viewer, and binary versus
  base64 by capability.
- `ScreencastView` (renderer, jsdom): event mapping, coordinate scaling,
  move coalescing, the reserved chords never sent, picker overlay rendering
  and choice, IME sequence.

### 9.2 Integration (skipped when no Chromium is found; required in CI)

CI's Linux job installs the pinned headless shell through the product's own
installer (so the download path is exercised) and the E7 library list. It runs
the following, with `SPRINTENGINE_TEST_CHROMIUM` pointing at the binary:

- **The canvas worker end to end** with the real built page (E3's harness,
  turned into a test):
  - ready report;
  - `apply-edit` label widths equal checked-in values for the three warmed
    families;
  - `export-image` dimensions equal and a perceptual diff against a golden
    **made on the same platform and engine** under 0.5 % of pixels;
  - mermaid flowchart and pie;
  - `export-svg` parses as SVG;
  - zero non-origin requests leave the page.
- **The browser** against a local fixture server: every `browser.*` tool;
  dialogs, popups, file chooser, downloads, auth; isolation between two
  workspace profiles; persistence across a park.
- **Screencast**: frames arrive, input clicks land at the right coordinates,
  and the picker flow sets a `<select>`.
- **Electron child**: on the macOS runner, the same canvas and browser suites
  run against `electron-child`.

### 9.3 Security tests

- No TCP listener owned by any render process: `lsof -a -p` on macOS,
  `/proc/<pid>/net/tcp` inode matching on Linux.
- The canvas page cannot fetch `https://example.com`.
- Agent tabs cannot load `file:///etc/passwd`, `chrome://version`, or the
  server's own loopback port.
- Downloads are denied until allowed, and allowed ones land only under
  `render/downloads/<workspace>/`.
- `browser.input` without `browser:operate` is refused. A legacy tailnet
  pairing has no `browser:*` scope.
- The UA contains no `HeadlessChrome`, and `navigator.webdriver` is false.

### 9.4 Container and host matrix (CI job, weekly and on render changes)

| Image / options | Expected |
| --- | --- |
| `debian:12-slim`, no libraries | probe lists the 20 libraries with the apt line; launch is never attempted |
| `debian:12-slim` + libraries, default Docker profile | `no_sandbox` with cause `seccomp`, fix names `seccomp=unconfined` |
| same, `seccomp=unconfined` | canvas and browser suites pass, sandboxed |
| `ubuntu:24.04`, `seccomp=unconfined,apparmor=unconfined` | `no_sandbox` with cause `apparmor_userns`, fix is the AppArmor profile |
| same, after loading the generated profile (privileged setup step) | suites pass |
| `alpine` | `musl` |
| as root | cause `root` |
| linux-arm64 runner | suites pass |

WSL2 (Ubuntu 24.04 and Debian) is checked manually once per release, until a
Windows runner with WSL exists. The checks: the sandbox starts, the probe is
clean after the documented package line, and a canvas screenshot works.

## 10. Risks and mitigations

| Risk | Evidence | Mitigation |
| --- | --- | --- |
| The sandbox cannot start on Ubuntu 23.10+ hosts and in default containers | reproduced (E7) | probe with the exact cause; prefer a distribution Chrome there; a one-command AppArmor profile; container option documented; `allowNoSandbox` only as a per-host owner choice (D5); the desktop's Electron child is unaffected |
| The screencast pane is less capable than the native pane (pickers, DevTools, rich clipboard, drag and drop, password manager) | reproduced for pickers (E8) | the picker overlays, clipboard bridge, IME mapping and console/network drawer in 5.7; the rest accepted under D1; the `<webview>` pane is kept behind a setting until the parity checklist passes |
| Memory: one process per workspace profile | E1: 230–370 MB idle, ~80–90 MB per tab | pool cap 4, LRU park, 15-minute idle, per-process ceiling; the Electron child holds all profiles in one process on desktops |
| Text measured differently on a server than on a client | reproduced (E3) | `--font-render-hinting=none` makes web-font metrics match exactly; emoji and CJK still depend on host fonts (probe warning, D6, D7); a test pins widths |
| Missing libraries on minimal hosts | reproduced: 20 on Debian slim | the probe and the package line; never a cryptic exit 127 |
| The worker fetches Xiaolai from esm.sh; it does so today in the app | reproduced (E3) | offline canvas process; bundle Xiaolai (D6) |
| A packaged Electron child behaves differently: dock flash, single-instance lock, asar-only loading | not tested in a packaged build | render-host mode branches first thing in `app-main.ts`; a packaged smoke test in 5a launches it and renders a board; the macOS `dock.hide()` before `ready` |
| Pinned Chromium goes stale (security) | — | bump with every app release; scheduled pin-bump job; `server.info` flags a stale pin |
| Chrome for Testing terms and redistribution | archives are Google-branded binaries under Google's terms (E2 `ABOUT`) | never redistributed: each host downloads from Google's bucket (D4); our own SHA-256 pins |
| Bot checks on a `HeadlessChrome` UA | the shell's UA says `HeadlessChrome` | UA override and client hints (4.3); no `--enable-automation` |
| Unbounded frame queues on slow links | E5: ~3 frames in flight regardless of ack | latest-frame slot per viewer, `slow_consumer` cut-off |
| Bandwidth on the tailnet / phone | E5: up to 9–15 Mbit/s on a full-motion page; ~0 static | 15 fps / q60 over the tailnet, DPR capped, frames only on paint |
| A blocking `alert()` stalls an agent | today: likely (not tested) | `dialog_open` error and `browser.dialog` (D11) |
| A page in the agents' browser probes the server's own listeners | — | deny-list of the server's own origins (4.7); listeners authenticated regardless |
| Disk: profiles and caches grow | — | `--disk-cache-size` 64 MB; profiles of removed workspaces deleted with the workspace; `server.info` shows the sizes |
| Inactive tabs stop painting in a full Chrome | reproduced in `--headless=new` (E1) | `Page.bringToFront` on the viewed tab; `backgroundThrottling:false` in the Electron child; a non-issue for the shell |
| Sign-ins in today's shared pane partition are left behind | `BROWSER_PARTITION` is machine-wide by design | D2: import cookies from `persist:sprintengine-browser` into each workspace profile once, on the desktop, or start clean |

## 11. Decisions needed from the owner

**D1. Accept the screencast pane's losses on the desktop?** These are DevTools,
native pickers (replaced by in-app ones), drag and drop of files, rich
clipboard, inline PDF (under D3) and the password manager.

*Recommendation:* yes, as the owner default implies. Keep the `<webview>` pane
behind a setting until the parity checklist (section 8) passes, and give the
pane a Console and Network drawer instead of DevTools. Remote DevTools (serving
the DevTools frontend over the authenticated socket) is a later option, kept
out of v1 because it hands a client the full CDP.

**D2. The browser profile model.** Three options:

- (a) **one persistent profile per workspace**: a process per workspace on
  Chromium, a partition per workspace on the Electron child;
- (b) **one persistent profile per server**, shared across workspaces, which is
  today's model;
- (c) **ephemeral contexts per workspace**, where sign-ins are lost at every
  idle park.

*Recommendation:* (a), with the pool cap. It is the isolation the parent design
asks for and the only option where sign-ins survive. Also import today's
shared-partition cookies into each workspace profile once on first use, on the
desktop, so nobody has to sign in again. (b) is acceptable if memory on small
hosts matters more than isolation. (c) is not recommended.

**D3. Which Chromium to download.** The options are `chrome-headless-shell`
(99–121 MB, 234–369 MB idle, no PDF viewer and no extensions) or full Chrome
for Testing in new headless (191–197 MB, about four times the idle memory, and
real Chrome behaviour).

*Recommendation:* the headless shell for v1. It is half the download and a
fraction of the memory, and E1/E3/E5 found no tool or canvas behaviour it
lacks. Revisit if people browse PDFs in the pane.

**D4. Where the download comes from.** The options are Google's Chrome for
Testing bucket with our SHA-256 pins, a mirror on our own release storage, or
our own Chromium build.

*Recommendation:* Google's bucket. It is the only one of the three that does
not redistribute a Google-branded binary under Google's terms (and its codecs),
and it costs no build infrastructure. A mirror needs a legal review first; our
own build is a project of its own.

**D5. When the sandbox cannot start.** The owner default is "sandbox on".

*Recommendation:* never fall back silently. The probe names the cause and the
one-time fix. A per-host owner setting `render.allowNoSandbox` exists for
containers and CI, applies to the canvas process and the agents' browser alike,
is off by default and shows a persistent warning in `server.info`. No implicit
exception for the canvas: board files contain agent- and import-supplied text
and images that Chromium's decoders parse.

**D6. Bundle the Xiaolai CJK font (12 MB, 209 files, OFL)?**

*Recommendation:* yes, in the server bundle and the desktop. CJK labels are
then measured identically everywhere, and neither the worker nor the pane
fetches fonts from esm.sh, which the app does today.

**D7. Bundle an emoji font for the canvas worker on Linux hosts?**

*Recommendation:* not in v1. The probe warns, and the package line fixes it.
The width difference against a macOS client (306 vs 303 px in E3) remains
either way, because clients use their own emoji fonts.

**D8. Keep the attached-client canvas fallback (parent 8.4)?**

*Recommendation:* drop it. Desktops now render with their own Electron child,
so the fallback would serve only a headless host whose Chromium cannot start,
and the probe's fix is better than a second code path.

**D9. Split phase 5 into 5a (render host and canvas), 5b (agents' browser)
and 5c (the pane as a view)?**

*Recommendation:* yes. Each is shippable, and 5a alone delivers canvas tools
with no window.

**D10. Who downloads Chromium for WSL and SSH hosts?**

*Recommendation:* the host itself when it can reach the bucket, and the client
streaming it as a fallback. The parent design has the client always stream it;
100+ MB over SSH from a laptop is slow.

**D11. Add a `browser.dialog { accept, promptText? }` tool and a
`dialog_open` error now?**

*Recommendation:* yes, in 5b. With no person watching, a dialog otherwise
blocks the agent until its deadline. A file-upload tool waits.

## 12. Commits

Each commit leaves `npm run verify:app` green. Sizes are relative.

**5a — the render host and the canvas**

1. `docs(studio-server)`: this spec. *(this commit)*
2. `build`: add `devtools-protocol` (types only). `feat(render)`: CDP over a
   pipe (`cdp.ts`), with no consumers. Tests: framing, correlation, EOF. (S)
3. `feat(render)`: the Chromium source chain, the pin manifest and
   `scripts/pin-chromium.mjs`; download, verify, unzip and install under
   `flock`. Tests against a local fixture server. (M)
4. `feat(render)`: the host probe (libraries, glibc, sandbox cause, fonts) with
   fixture tests. (S)
5. `feat(render)`: `RenderHost` with the `chromium` backend: launch flags,
   pool, idle, crash and memory rules, status. Tests with a fake backend; the
   integration job added (skipped when no Chromium is present). (M)
6. `feat(render)`: the `electron-child` backend: the `--sprintengine-render-host`
   mode in `app-main.ts`, the stdin control channel, offscreen partitions. A
   packaged smoke test. (M)
7. `feat(canvas)`: the CDP canvas worker transport (bridge, `Fetch`-served
   origin, offline), behind `render.canvasTransport`; the `export-svg`
   operation; the font report extended by the probe. Integration test from E3.
   (M)
8. `feat(canvas)`: bundle Xiaolai (if D6), with `canvasSceneFontsPlugin`
   updated. (S)
9. `feat(protocol)`: the `canvas` namespace (`list`, `open`, `board` stream,
   `commitScene`, `exportImage`); `canvas-subscribers.ts` keyed by
   subscription. (M)
10. `feat(canvas)`: default `render.canvasTransport` to `render-host`; the
    `server.info` render section; Settings shows source, probe and fixes. (S)

**5b — the agents' browser on the render host**

11. `refactor(browser)`: the `CdpSession` seam under `browser-control.ts`, with
    the Electron debugger implementation; `capturePage` → `Page.captureScreenshot`.
    Tests parameterised over both. No behaviour change. (M)
12. `feat(browser)`: `BrowserTabsService` on the render host: per-workspace
    profiles, persisted tabs, park/unpark, popups as tabs, navigation and
    origin policy, permissions, UA override, `resize` via emulation, epoch
    origins. `browser-tools.ts` resolves against it when the setting
    `render.agentBrowser` is on; `browser.open` creates a tab with no window.
    (L)
13. `feat(browser)`: dialogs, file chooser, downloads and HTTP auth states;
    the `browser.dialog` tool (if D11). (M)
14. `feat(protocol)`: the `browser` namespace (`tabs`, `focus`, the toolbar
    commands, `screencast` with binary frames, `input`, `selection`, `pick`,
    the respond methods, downloads); `websocket-frames.ts` gains the one binary
    message kind. Fan-out tests. (M)

**5c — the pane as a view**

15. `feat(browser-pane)`: `ScreencastView` (frames, input, IME, cursor, focus)
    and the picker overlays; the Console and Network drawer; the element picker
    over `Overlay`. Behind `browserPane.mode: 'webview' | 'screencast'`. (L)
16. `feat(browser-pane)`: clipboard bridge, file chooser upload, download
    serving, dialog and auth prompts in the pane; cookie import from the shared
    partition (if D2 (a)). (M)
17. `feat(browser-pane)`: default to `screencast` once the parity checklist
    passes. (S)
18. `refactor(browser)`: remove the `<webview>` pane, `browser-guest` preload,
    `guest-policy.ts`, the Electron `CdpSession`, the canvas worker window and
    its preload API, and `webviewTag`. The guard test's list grows by
    `src/server/render/` and `src/server/browser/`. (M)

## 13. Licensing

- **Chrome for Testing archives** contain Google-branded binaries. Their
  `ABOUT` file says "Google Chrome … See the Terms of Service at
  chrome://terms". The tooling repository's Apache-2.0 licence covers the
  scripts, not the binaries. Downloading them on the person's own host from
  Google's bucket, on first use, is how browser automation libraries
  distribute them, and is what D4 recommends. Shipping them inside our
  archives, or mirroring them, is redistribution and needs review first. The
  third-party notices (`LICENSE.headless_shell`, 2.3 MB) sit beside the binary
  and are shown from Settings → About.
- **Electron**, as the desktop's render host, is the binary the app already
  ships under its MIT and Chromium notices. Nothing new.
- **Fonts.** Xiaolai (D6) and Noto Color Emoji (D7) are under the SIL Open
  Font License, which allows bundling with the licence text included. The
  Excalidraw families are already bundled.
- **`devtools-protocol`** is BSD-3-Clause, and is used for types only.
