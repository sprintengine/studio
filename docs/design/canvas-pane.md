# Canvas pane — implementation plan

Status: landed on `main`; packages A–G are in, and the integration pass (G) has
been exercised against a running dev instance. This file is the contract the
work was split against. When code and this file disagree, fix one of them in
the same change.

## 1. What is being built

A **Canvas** tab in the workspace pane: a hand-drawn-style whiteboard the person
can draw on, and that an agent can read, edit and screenshot through a new
`canvas.*` tool family on the Studio MCP gateway.

The editor is the open-source `@excalidraw/excalidraw` package (MIT), pulled in as
a dependency and lazy-loaded. Nothing of the editor is reimplemented.

### Decisions already taken (owner-approved direction, 2026-09-17)

| Decision | Ruling |
|---|---|
| Editor | `@excalidraw/excalidraw@0.18.1` as a dependency. No rewrite. |
| Source of truth | A `.excalidraw` file inside the project. Main owns read, merge and write. |
| Default folder | `diagrams/` at the workspace root (`folderPath`, the same root the backlog and the browser sidecar resolve against). Tools and the tab accept any project-relative `*.excalidraw` path. |
| Geometry | A hidden **canvas worker** window owned by main runs everything that needs a DOM (skeleton conversion, arrow binding, Mermaid import, image export). No canvas tool depends on a visible window or a mounted pane. |
| Pane tab | Core tab kind `canvas`, gated by a bundled renderer module `canvas`, retained while hidden (like browser and terminal). |
| Narrow pane | A person-initiated new Canvas tab maximises the pane. An agent-initiated `canvas.open` reveals the tab docked and never maximises. |
| Agent format | Agents write a small **skeleton** format and name the shapes an arrow connects. Agents never author raw bindings. |
| Concurrency | Per-element version merge. The person always wins a shape both sides touched: an agent edit that collides is recomputed once against the board the person left, and only then fails `interrupted`. A gesture on its own abandons nothing. |

### House rules that bite here

- `AGENTS.md`: no competitor product names in comments, tests or docs. The npm
  package name is a technical identifier and may be named where the code needs
  it. Do not name any other whiteboard product or community project anywhere.
- No real identities in fixtures (`/Users/dev/...`, `acme`, `dev@example.com`).
- `npm run lint` (five design-system lints) and the bundle budget are gates.
  Chrome written by us uses `components/ui` primitives and `--sem-*`/shell tokens
  only. No raw `<button>`/`<input>`, no hex literals, no `rounded-2xl`.
- Tests are Vitest files asserting with `node:assert/strict`, colocated
  `*.test.ts(x)`, discovered automatically by `npm test`.
- Tool registrations use hand-written JSON Schema with `additionalProperties:
  false` and a `description` on every property. Skills never restate schemas.

## 2. Architecture

```
agent CLI ── stdio bridge ── MCP socket ── canvas-tools.ts
                                              │
                                              ▼
                       ┌──────────── CanvasService (main) ────────────┐
                       │  board registry, revision, merge, atomic     │
                       │  write, fs watch, presence, action log       │
                       └───────┬───────────────────────────┬──────────┘
                               │ worker-protocol            │ canvas:* IPC push / invoke
                               ▼                            ▼
                    hidden canvas worker window      Canvas tab in the pane
                    (convert, bind, layout,          (the live editor: view +
                     mermaid, export image)           person's edits)
                               
                     <workspace root>/diagrams/*.excalidraw   ← source of truth
```

Data flow:

- **Agent edit**: tool → `CanvasService.edit` → worker `apply-edit` (returns the
  full next element array, versions bumped, bindings repaired) → service merges
  against the current in-memory scene, writes the file atomically, bumps
  `revision`, pushes `canvas:scene` to every subscribed window. The tab applies
  the push with element reconciliation and without touching the undo stack,
  buffering while the person is mid-gesture.

  The tab reconciles a push **directly**, without `restoreElements` first.
  Verified against the shipped 0.18.1 source: `restoreElements(remote, local)`
  bumps any remote element the local copy is ahead of to `local.version + 1`
  (which then wins the reconcile — the inverse of "the person always wins"),
  runs `syncInvalidIndices` over the remote array alone, and drops invisibly
  small elements including their tombstones. Nothing in a push needs repairing:
  every element main holds came from the library, through the worker or through
  a tab's own commit, and the cold path goes through `initialData`, which the
  editor restores itself.

  What the editor DOES change while accepting a push has to reach main, or the
  two sides sit on the same element at the same version with different nonces
  and the next agent edit to it is decided by a nonce coin toss. So the tab's
  echo guard records the hash of the scene MAIN sent, not the one that ended up
  on screen: equal hashes mean the apply was silent, and a difference leaves the
  editor looking like an unsent change, which the debounce already running
  commits once. The case that makes this load-bearing is an agent-created
  element, which arrives with `index: null` (the worker declines to invent a
  fractional index) and is given one — and a version bump — by the
  `syncInvalidIndices` inside `reconcileElements`. Without it, roughly half of a
  later agent update to those elements was invisible in the tab, tearing a box
  away from its own label.
- **Person edit**: tab `onChange` (debounced ~400 ms, skipped when the scene
  version hash is unchanged) → `canvas:commit-scene` with `baseRevision` and the
  full element array including tombstones → service merges by element version,
  writes, bumps `revision`, pushes to *other* subscribers.

  **How "the person always wins" is actually enforced**, because the words are
  easy to read as something stronger than they are. There is no abandonment on
  a gesture. `canvasNoteHumanInput` moves the presence badge and nothing else;
  it never cancels anything. What protects the person's work is the merge and
  one retry:

  * The worker computes an edit against a snapshot of the board, OUTSIDE the
    board's queue, so the person's save never waits behind an agent's geometry.
  * At the head of the apply step the service compares, element by element,
    every id whose version that computation moved — the ones the agent named
    AND the ones the worker repaired on its own, such as a shape that gained an
    arrow in `boundElements` — against the board as it now stands. An id whose
    version or nonce has moved under the edit is contested.
  * A contested edit is recomputed once, against the board the person left. If
    it is contested a second time the agent is told `interrupted` and nothing is
    written; the person's version stands.
  * Everything else merges: two writers on different elements never collide,
    because for one id the higher version wins and ids only one side has are
    kept.

  So an agent edit that lands mid-gesture on shapes the person is not touching
  applies, and is visible when they let go — that is the buffering in the tab,
  not an abandonment in main.
- **Disk edit** (git checkout, a text edit of the JSON): service's watcher sees a
  content hash it did not write → reload, merge, push with `origin: 'disk'`.

  The watcher marks the board dirty the moment it fires, not when its 150 ms
  debounce runs, and every write step settles that flag before it writes. Our
  own write records its hash, so a change landing inside the debounce window
  would otherwise leave the reload looking at content it thinks we wrote and
  dropping the other writer's work on the floor. If the file is unreadable AT
  THAT MOMENT the write is refused with `invalid_scene` and the file is left
  exactly as it is: it is nearly always another program mid-save and the next
  attempt goes through, and the alternative is replacing somebody's hand-edited
  file with our own idea of the board. A scene file this app cannot parse is
  never overwritten, on this path as on the load path.
- **Screenshot**: service → worker `export-image` with the current scene. Works
  with the pane closed.

One board per FILE, not per spelling. On darwin and win32 the registry key, the
pane's per-board tab key and the tab's push matching all fold the path to lower
case, because the filesystem does; on linux they do not. Display keeps whatever
spelling it was given, and when a board file already exists under another case
the on-disk spelling wins — the atomic write ends in a rename, and a rename to
the other spelling renames the person's file out from under git.

After every merge the two halves of each binding are made whole again
(`repairBindingPairs`). A binding is a PAIR of references and the merge decides
per ELEMENT, so the halves can arrive from different writers: a shape the person
moved while an agent fastened an arrow to it wins the merge outright,
`boundElements` and all, and the arrow is then listed nowhere — it follows the
shape, but dragging the shape leaves it behind. Only the missing half is ever
added, never removed, so detaching an arrow (which clears the arrow's own
binding too) stands.

Merge rule (pure, in `src/shared/canvas/merge.ts`): for the same id the higher
`version` wins; on a tie the lower `versionNonce` wins; ids present on only one
side are kept; deletions are `isDeleted: true` tombstones with a bumped version.
Tombstones older than 24 h are dropped at write time.

## 3. Contracts

### 3.1 Shared, node-free: `src/shared/canvas/`

| File | Contents |
|---|---|
| `types.ts` | `CanvasElement` (structural: `id`, `type`, `version`, `versionNonce`, `isDeleted?`, `updated?`, plus index signature), `CanvasSceneFile`, `CanvasBoardRef {workspaceId, path}`, `CanvasBoardSummary {path, name, elementCount, modifiedAt}`, `CanvasBoardState {path, revision, elements, appState, files}`, `CanvasSkeleton`, `CanvasEditRequest`, `CanvasEditResult`, `CanvasLayoutRequest`, `CanvasImportRequest`, `CanvasImage {data, mimeType, width, height}`, `CanvasLintIssue`, `CanvasLintReport`, `CanvasPresence`, `CanvasActionEntry`, `CanvasScenePush`, `CanvasError {code, message}` and the `CanvasResult<T>` union. |
| `paths.ts` | `CANVAS_DEFAULT_FOLDER = 'diagrams'`, `CANVAS_FILE_EXTENSION = '.excalidraw'`, `CANVAS_LIST_MAX_BOARDS = 200`, `normalizeCanvasPath(input)` (posix, project-relative, rejects `..`, absolute paths and other extensions; a bare name lands in the default folder; the extension is accepted in ANY case and kept exactly as given, so a file already on disk is never renamed; `.git`/`node_modules` are refused case-insensitively on every platform), `canvasBoardName(path)`, `canvasPathIsCaseInsensitive(platform)`, `canvasBoardKeyPath(path, platform)`. |
| `scene-file.ts` | `emptyScene()`, `parseSceneFile(text)` (tolerant: repairs missing arrays, rejects non-objects), `serializeSceneFile(scene)` (2-space JSON, trailing newline, `source: 'sprintengine-studio'`, appState reduced to `viewBackgroundColor`, `gridSize`, `gridStep`, `gridModeEnabled`). |
| `merge.ts` | `mergeElements(local, incoming)`, `dropStaleTombstones(elements, now)`, `sceneVersionHash(elements)`. |
| `skeleton.ts` | `toSkeleton(elements)`: projects live elements to the agent format (bound label text folded into its container as `text`; arrow bindings folded to `startElementId`/`endElementId`; coordinates rounded to integers). `validateSkeleton` / `validateEditRequest` return `CanvasError`s, never throw. |
| `describe.ts` | `describeScene(elements, detail: 'summary' \| 'outline' \| 'full')`: counts, bounding box, one line per element sorted top-to-bottom then left-to-right, a Connections section, a Groups/Frames section. Bounded to 24 000 characters with an explicit truncation line. |
| `find.ts` | `findElements(elements, {query?, type?, bbox?, ids?})`: case-insensitive, separator-insensitive contains. Returns skeletons. |
| `lint.ts` | `lintScene(elements)`: `overlap`, `cramped` (< 40 px), `text_overflow`, `dangling_binding`, `one_way_binding`, `short_arrow` (< 80 px), `arrow_tip_inside_shape`, `fan_in_same_focus`, `duplicate_id`. Severity weights 10/4/1, `score = max(0, 100 - sum)`. It runs on the MAIN thread, on every edit and every read-only describe, so the three pairwise rules are bucketed into a uniform grid (two elements within the cramped distance always share a cell), collection stops at 200 issues, and a shared candidate-pair budget ends the scan. A report that stopped early carries `truncated: true` and a `notes` line saying so, and `omitted` is then a floor. |
| `diff.ts` | `summariseChanges(before, after)`: added / removed / moved-or-resized / retexted, as short text lines. Used for "what the person changed since you last read". |
| `worker-protocol.ts` | `CanvasWorkerRequest` / `CanvasWorkerResponse` unions with a `requestId`: `apply-edit`, `layout`, `import-mermaid`, `import-scene`, `export-image`. Plus `CanvasWorkerReport {loaded, missing, errors}`, which the readiness handshake carries. `apply-edit` and `layout` successes carry `changed: string[]` — EVERY id whose version the worker moved, the ones nobody named included (a shape that gained an arrow in `boundElements`, a label a retext tombstoned) — which is what the service tests for a collision; `result.updated` stays the agent's own list. `layout` also carries an optional `warnings`. |

**Skeleton** (agent-facing element):

```ts
type CanvasSkeleton = {
  id?: string            // existing element id (update/find output)
  tempId?: string        // same-request handle for new elements
  type: 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'arrow' | 'line' | 'frame'
  x: number; y: number; width?: number; height?: number
  text?: string          // label for shapes/arrows, content for text
  startElementId?: string; endElementId?: string   // arrows/lines; id or tempId
  points?: Array<[number, number]>; elbowed?: boolean
  startArrowhead?: string | null; endArrowhead?: string | null
  strokeColor?: string; backgroundColor?: string
  fillStyle?: 'solid' | 'hachure' | 'cross-hatch'; strokeStyle?: 'solid' | 'dashed' | 'dotted'
  strokeWidth?: number; roughness?: number; opacity?: number
  fontSize?: number; fontFamily?: 'hand' | 'normal' | 'code'; textAlign?: 'left' | 'center' | 'right'
  rounded?: boolean; locked?: boolean
  children?: string[]; name?: string        // frames
  groupId?: string
}
type CanvasEditRequest = {
  delete?: string[]
  update?: Array<{ id: string; set: Partial<Omit<CanvasSkeleton, 'id' | 'tempId' | 'type'>> }>
  create?: CanvasSkeleton[]
}   // applied in the order delete → update → create
```

### 3.2 `ElectronApi` additions (`src/shared/electron-api.ts`)

Pane side:

```ts
canvasListBoards(workspaceId: string): Promise<CanvasResult<CanvasBoardSummary[]>>
canvasOpenBoard(input: { workspaceId: string; path: string; create?: boolean }): Promise<CanvasResult<CanvasBoardState>>   // subscribes the sender
canvasCloseBoard(input: CanvasBoardRef): Promise<void>
canvasCommitScene(input: CanvasBoardRef & { baseRevision: number; elements: CanvasElement[]; appState: Record<string, unknown>; files: Record<string, unknown> }): Promise<CanvasResult<{ revision: number; elements: CanvasElement[] | null }>>  // elements non-null only when the merge differs from what was sent
canvasNoteHumanInput(input: CanvasBoardRef): void
onCanvasScene(cb: (push: CanvasScenePush) => void): () => void
onCanvasPresence(cb: (p: CanvasBoardRef & CanvasPresence) => void): () => void
onCanvasOpenRequest(cb: (req: CanvasBoardRef) => void): () => void
```

Worker side: `canvasWorkerReady(report: CanvasWorkerReport): void`, `onCanvasWorkerRequest(cb): () => void`,
`canvasWorkerRespond(response: CanvasWorkerResponse): void`.

Channels: `canvas:list-boards`, `canvas:open-board`, `canvas:close-board`,
`canvas:commit-scene`, `canvas:note-human-input` (invoke/send);
`canvas:scene`, `canvas:presence`, `canvas:open-request` (push);
`canvas-worker:ready`, `canvas-worker:request`, `canvas-worker:response`.

### 3.3 Main: `src/main/canvas/`

`canvas-service-types.ts` defines the interface both the service and the tools
code against:

```ts
type CanvasActor = { kind: 'agent'; workspaceId: string; agentId?: string; agentName?: string } | { kind: 'human' }
interface CanvasService {
  listBoards(workspaceId: string): Promise<CanvasResult<CanvasBoardSummary[]>>
  readBoard(ref: CanvasBoardRef, opts?: { create?: boolean }): Promise<CanvasResult<CanvasBoardState>>
  edit(ref: CanvasBoardRef, edit: CanvasEditRequest, actor: CanvasActor): Promise<CanvasResult<{ state: CanvasBoardState; result: CanvasEditResult }>>
  layout(ref: CanvasBoardRef, request: CanvasLayoutRequest, actor: CanvasActor): Promise<CanvasResult<{ state: CanvasBoardState; warnings: string[] }>>
  importContent(ref: CanvasBoardRef, request: CanvasImportRequest, actor: CanvasActor): Promise<CanvasResult<{ state: CanvasBoardState; result: CanvasEditResult }>>
  screenshot(ref: CanvasBoardRef, opts: { elementIds?: string[]; maxEdge?: number; background?: boolean; dark?: boolean }): Promise<CanvasResult<CanvasImage>>
  requestOpen(ref: CanvasBoardRef): Promise<CanvasResult<{ revealed: boolean }>>
  changesSinceLastRead(ref: CanvasBoardRef, readerKey: string): string[]   // and marks read
  actions(ref: CanvasBoardRef): CanvasActionEntry[]
  dispose(): Promise<void>
}
```

Files: `canvas-service.ts` (`createCanvasService(deps)`, deps injected for
tests: fs, clock, `resolveWorkspaceRoot`, `broadcast`, worker host),
`canvas-worker-host.ts` (hidden `BrowserWindow`, created on first use, disposed
after 5 min idle, `requestId` correlation, 20 s per-request deadline, one retry
after a crashed worker), `src/main/ipc/canvas-ipc.ts`
(`registerCanvasIpc`). Atomic write = temp file + rename. Screenshot budget:
longest edge ≤ 1024 px, JPEG q80 above 600 KB of PNG, so a result stays under the
gateway's 1 MiB line limit.

Error codes: `no_workspace`, `unknown_workspace`, `forbidden`, `invalid_path`,
`not_found`, `invalid_scene`, `invalid_edit`, `unknown_element`, `interrupted`,
`worker_unavailable`, `timeout`, `too_large`.

### 3.4 Tools: `src/main/automation/canvas-tools.ts`

`createCanvasTools({ service, hasWorkspace, isCanvasEnabled }): McpToolRegistration[]` plus
`CANVAS_MUTATION_TOOL_NAMES`. Workspace resolution copies the browser family
(connection-bound workspace, explicit `workspaceId` only when unbound;
`forbidden` / `no_workspace` / `unknown_workspace`). Every tool takes an optional
`board` (project-relative path or bare name, through `normalizeCanvasPath`);
omitted, it targets the workspace's most recently CHANGED board (`listBoards`
sorted by `modifiedAt`), else `diagrams/canvas.excalidraw`. A mutating tool
creates that board on demand (`readBoard(ref, { create: true })`); a read tool
answers `not_found` with the two tools that would create it.

| Tool | Mutates | Behaviour |
|---|---|---|
| `canvas.list` | no | Boards under the workspace root, newest first, capped at 200. |
| `canvas.open` | yes | Create if missing, reveal the tab docked. Reports `revealed: false` without failing when no window shows the workspace. |
| `canvas.describe` | no | `detail` summary/outline/full. Appends lint score (top 10 issues), the person's changes since this agent last read (reader key `workspaceId\0agentId`), and the last 10 actions. `full` also returns `toSkeleton` elements, swapped for the outline plus a pointer at `canvas.find` past 150 KB of skeleton JSON. |
| `canvas.find` | no | Skeletons matching `query`/`type`/`bbox`/`ids`; at least one filter, capped at 200 with the omitted count. |
| `canvas.edit` | yes | `delete`/`update`/`create`, passed straight to the service, which validates them. Returns the tempId→id map, the id lists, warnings and the lint report (20 issues). Rejects only an edit naming none of the three. |
| `canvas.layout` | yes | `op`: align, distribute, stack, group, ungroup, lock, unlock. |
| `canvas.import` | yes | Exactly one of `mermaid` text or `scene` JSON, `mode` merge (default) / replace. |
| `canvas.screenshot` | no | Whole board or `elementIds`. Image content block plus a one-line caption; the base64 never enters `structuredContent`. |

With `isCanvasEnabled()` false every tool stays listed and answers
`canvas_module_disabled` in the gateway's own words for a disabled module. Every
`CanvasError` maps to a tool failure with the same code and message; a bad
argument the service never sees answers `invalid`.

### 3.5 Renderer

- Tab kind `canvas` in `types/workspace.ts`, `workspacePaneSlice.ts` (multi-tab,
  one tab per board path: opening a path that already has a tab focuses it; tab
  field `canvas?: { path: string }`; `setPaneTabBoard` is how a tab GAINS a
  board, because a board another tab already holds brings that tab forward and
  closes this one rather than leaving the normalizer to drop a duplicate after
  the fact), `paneKinds.tsx` (letter `C`, `moduleId:
  'canvas'`, retained), `WorkspacePaneBody.tsx` (lazy, hidden layer uses
  `invisible`, not the offscreen transform).
- Module `src/renderer/src/modules/canvas-module.ts`, registered in
  `modules/index.ts`.
- Panel in `src/renderer/src/components/workspace/pane/canvas/`:
  `CanvasTab.tsx` (the board's lifecycle, the board actions and the picker —
  imports nothing of the editor), `CanvasEditor.tsx` (the only importer of the
  package, reached by `React.lazy` from the tab; the live scene, both sync
  directions and the collaborator an agent's presence draws),

  `canvasSync.ts` (pure: busy detection, push buffering, echo suppression;
  unit-tested), `CanvasBoardPicker.tsx` (start surface: existing boards + new
  board, `ui/` primitives) over `canvasPickerModel.ts` (pure: paging, the
  clamp, duplicate names, the next unused default name, the short changed
  time; unit-tested), `canvasTheme.css` (the one file mapping the
  editor's CSS variables to our tokens, and the one rule that re-hides a
  retained board's subtree: the pane hides an inactive layer with
  `visibility: hidden`, and the library's stylesheet takes `visibility` back on
  four of its own nodes, so a hidden board painted — and hit-tested — its zoom
  and undo controls over the tab in front of it). Presence is not its own component:
  the badge is a `renderTopRightUI` return and the collaborator is an
  `updateScene` call, and neither is a surface of its own.

  **The picker is a LIST CARD** (owner, 2026-09-17: the first draft "doesn't
  follow the styling of any other list in our design system", and of the three
  options drawn for the redraw the list card was chosen). It is the idiom the
  app already lists agent CLIs, skills and paired devices with: a quiet
  `Boards` heading with the total beside it in mono, the `New board`
  `PrimaryButton` right-aligned on that same line, one `SettingCard as="ul"`
  holding a row per board, and the kit `Pager` at its foot. One column at every
  pane width, in a 720px column centred on the pane's own `bg.surface`.

  It is deliberately NOT the pane launcher's grid of tiles, which it otherwise
  sits a few pixels away from. The launcher offers a fixed set of six tools and
  will offer six tomorrow; boards are documents — an open-ended set that grows
  with the project, sorted newest first — and a growing set is read by name and
  by recency down one column. Two columns of tiles break that reading order and
  spend more height doing it.

  Row anatomy, composed from the same kit parts `ConnectorRow surface="card"`
  uses so a board row and a skill row are the same row: the kit `ExtensionIcon`
  plate carrying `CanvasGlyph` (exported from `paneKinds.tsx`, so the tab's mark
  and the row that opens that tab are one drawing), the board's name in the bold
  body style through `TruncatedText`, and the changed time right-aligned in the
  mono meta slot. Composed rather than imported: `ConnectorRow`'s target is
  named "Show details for …" and its trailing slot sits outside the button,
  where a board's row opens a board and is pressable to its right edge.

  Three rules the rows follow:

  * **No folder.** A folder repeated down every row is a column of the word
    `diagrams` (owner, 2026-09-17). The exception is the only case a name cannot
    survive: two boards called the same thing each say their folder in the mono
    meta slot beside the name. The row's accessible name always says the folder
    and the time in full, because `5m` read aloud is not a time.
  * **Short times, no "ago".** `now`, `5m`, `2h`, `yesterday`, `2d`, then a
    short date past four weeks. Not `utils/relativeTime`: that formatter draws
    nothing for the first minute (right where it is used, wrong for a board
    saved seconds ago) and counts on in `mo`/`y` past a month.
  * **`Open` badge** on a board another tab of this pane already holds, with the
    R4 behaviour unchanged: activating it brings that tab forward and closes
    this one.

  `New board` opens the field IN PLACE, as a first row inside the card on the
  resting-selection fill: the same plate, a kit `Input` prefilled with the next
  unused default name (`canvas`, `canvas-2`, …) fully selected, `Create` and
  `Cancel` at the row's end. `N` opens it from anywhere inside the picker that
  is not a text field, the way the launcher's letters open its kinds. Enter
  creates, Escape cancels and puts focus back on the button the field replaced,
  and a name is refused in place — through `normalizeCanvasPath`, and against
  the names the project already has — rather than opening someone else's board.

  Ten boards to a page; the pager is drawn only when there is more than one.
  Paging does NOT move focus, which is the `Pager` spec's own rule: the page
  button keeps it and the range sentence is the live region that says the list
  changed.

**The tab draws no chrome of its own.** The editor fills the tab body from
directly under the pane's tab strip: no band, no hairline, no second copy of
the board's name (owner, 2026-09-17 — the strip already names the board, and
the repeated name cost a strip of drawing surface to say nothing new). What
the band held moved into space the editor already spends:

* "Switch board…", "Reveal file" (only when the workspace has a folder to
  reveal into — otherwise the item is left out rather than shown greyed) and
  "Copy path" are `MainMenu.Item`s in a group at the TOP of the editor's own
  menu, above its own items. `CanvasTab` passes them down as callbacks, so it
  still imports nothing of the package. They are library-rendered rows, so
  they are the editor's controls rather than ours and the kit-primitive lint
  does not reach them; the labels are still in our voice.
* The Agent badge is drawn through `renderTopRightUI`, beside the editor's
  own Library button, as our kit `Badge tone="accent"`. It renders `null`
  when no agent holds the pen, so the row reserves nothing for it. The
  library calls that prop in both its layouts — the desktop row and the
  compact one below 730 px — so one badge covers both.

The error, loading and not-yet-sized states fill the body with the kit
`EmptyState` / `SuspenseFallback` as before, band or no band.

- `WorkspacePaneColumn.tsx`: `onCanvasOpenRequest` effect mirroring the browser
  one, docked, never maximised.
- Command `panel.canvas.toggle`, shipped unbound, dispatched by
  `WorkspaceManager.runCommand` (no app-menu item, so main's menu is untouched).
- Worker app: `src/renderer/canvas-worker.html` + `src/renderer/src/canvasWorker/`
  as a third renderer entry. It mounts one hidden editor instance once so scene
  fonts load, then serves `CanvasWorkerRequest`s.

### 3.6 Build

- `@excalidraw/excalidraw@0.18.1`; `overrides.mermaid: "~11.13.0"`.
- `@excalidraw/mermaid-to-excalidraw@2.2.2` as a DIRECT dependency, at the
  version the editor package pins: the worker imports it by name, and a
  transitive dependency is not a contract.
- `tsconfig.web.json`: `moduleResolution: "bundler"`.
- Renderer `optimizeDeps.esbuildOptions.target: 'es2022'`.
- Scene fonts served at `<renderer root>/fonts/` in dev and emitted in build,
  without the CJK family. `window.EXCALIDRAW_ASSET_PATH` is an absolute URL set
  before the editor chunk evaluates; `window.EXCALIDRAW_EXPORT_SOURCE =
  'sprintengine-studio'`.
- `scripts/check-bundle-budget.mjs`: forbid the editor's signature in the eager
  chunk. The ceiling is not raised. The script no longer guesses the eager chunk
  by filename — a third HTML entry made Rollup hoist ~227 KB of React into a
  chunk `index.html` modulepreloads, and produced LAZY chunks also called
  `index-*.js` (the Mermaid importer, ~1 MB). It now sums the entry script and
  every `modulepreload` `index.html` actually lists, applies the same 2160 KB
  ceiling to that sum, and runs the forbidden-signature scan over all of them:
  1841 KB on this tree (1613 + 227). `scripts/measure-startup.mjs` reads the
  same document, for the same reason.

### 3.7 Skill

`resources/studio-plugin/sprintengine-studio/skills/studio-canvas/SKILL.md`:
when to draw, the describe → edit → lint → screenshot loop, palette and sizing,
section-by-section construction for large boards, "redesign on a failing lint,
do not nudge coordinates". Plugin version bump.

## 4. Work packages

| # | Package | Owns | Depends on |
|---|---|---|---|
| A | Build foundation | `package.json`, lockfile, `tsconfig.web.json`, `electron.vite.config.ts`, fonts step, asset-path bootstrap, bundle-budget signature | none |
| B | Shared contract + pure logic | `src/shared/canvas/**` with tests, `ElectronApi` additions, `src/main/canvas/canvas-service-types.ts` | none |
| C | Main service | `src/main/canvas/**` (except the types file), `src/main/ipc/canvas-ipc.ts`, `src/preload/api/canvas.ts`, preload index, `register-core-ipc.ts`, `app-services.ts` wiring, worker window creation | A, B |
| D | Pane tab | everything in 3.5 except the worker app | A, B |
| E | Canvas worker app | `src/renderer/canvas-worker.html`, `src/renderer/src/canvasWorker/**`, the renderer entry in the vite config | A, B |
| F | Tools + skill | `src/main/automation/canvas-tools.ts` + test, `studio-gateway-tools.ts` mutation table, `automation.test.ts` assertions, the skill, plugin version | B |
| G | Integration | typecheck, lint, tests, build, dev-launch smoke test, fixes across packages | C, D, E, F |
| H | Independent review | two reviewers (main+tools, renderer+worker), then a fix pass | G |

Every package ends with a self-review: re-read the diff, run the package's own
tests and `npm run typecheck`, and report what was verified and what was not.

## 5. Acceptance

1. `npm run verify:app` and `npm run build` are green; the eager chunk stays
   under the existing ceiling.
2. A person can open a Canvas tab, draw, close the app, reopen and find the
   drawing; the file under `diagrams/` is valid and opens in the stock editor.
   The TAB itself does not come back: the workspace pane's `paneState` never
   reaches the registry, so no pane tab of any kind (browser, terminal, git,
   files, canvas) survives a restart. That is the pane's own pre-existing gap,
   not this feature's, and it is out of scope here — the drawing is what this
   acceptance is about.
3. With the pane closed, `canvas.edit` creates two labelled boxes joined by an
   arrow; dragging a box in the tab afterwards keeps the arrow attached.
4. `canvas.screenshot` returns an image under the line limit with text in the
   hand-drawn font.
5. An agent edit arriving while the person is dragging does not interrupt the
   drag and is visible after release; the person's undo never removes agent work.
6. Disabling the `canvas` module greys the tab kind out of the launcher, and the
   tools stay listed but answer `canvas_module_disabled`. Core tools are not
   module-gated by the gateway, so the canvas tools check `isCanvasEnabled()`
   themselves, in the same words the gateway uses for a disabled module's tools.

## 6. Out of scope for this pass

A node/edge diagram generator with automatic layout (Mermaid import covers it
for now), attaching boards to backlog items, opening `.excalidraw` files from the
Files tab, the mobile companion, and a third-party pane-tab extension point.
