// The Canvas pane's main-process half: the one thing that owns a board file.
//
// Three writers touch a board and none of them can be asked to wait for the
// others — an agent through the `canvas.*` tools, the person through the pane,
// and git through the file. So this service is not a lock around a file, it is
// a small replica: every open board is held in memory with a revision, every
// write goes through `mergeElements`, and every accepted write is pushed to the
// windows watching it. The merge rule itself lives in `shared/canvas/merge.ts`
// and is pure; what lives here is the ordering, the fs, and who hears about it.
//
// Nothing here imports electron. A board's subscribers are numbers (WebContents
// ids the IPC layer hands out), the worker is an injected host, the filesystem
// is an injected facade and so is the clock — which is what lets the whole
// pipeline be tested without a window, a real disk or a real second.

import { createHash, randomInt, randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'

import type {
  CanvasActionEntry,
  CanvasBoardRef,
  CanvasBoardState,
  CanvasBoardSummary,
  CanvasBoundElementRef,
  CanvasEditRequest,
  CanvasEditResult,
  CanvasElement,
  CanvasError,
  CanvasImage,
  CanvasImportRequest,
  CanvasLayoutRequest,
  CanvasPresence,
  CanvasResult,
  CanvasScenePush,
} from '../../shared/canvas/types'
import { canvasFail, canvasOk } from '../../shared/canvas/types'
import {
  CANVAS_LIST_MAX_BOARDS,
  canvasBoardKeyPath,
  canvasBoardName,
  canvasPathIsCaseInsensitive,
  normalizeCanvasPath,
  CANVAS_FILE_EXTENSION,
} from '../../shared/canvas/paths'
import { emptyScene, parseSceneFile, reduceAppState, serializeSceneFile } from '../../shared/canvas/scene-file'
import { dropStaleTombstones, mergeElements, sceneVersionHash } from '../../shared/canvas/merge'
import { validateEditRequest } from '../../shared/canvas/skeleton'
import { lintScene } from '../../shared/canvas/lint'
import { summariseChanges } from '../../shared/canvas/diff'
import { isPathStrictlyInside } from '../path-containment'
import type { CanvasWorkerHost } from './canvas-worker-host'
import { canvasReaderKey } from './canvas-service-types'
import type { CanvasActor, CanvasService } from './canvas-service-types'

/** Main → renderer pushes. The invoke channels live in `ipc/canvas-ipc.ts`. */
export const CANVAS_SCENE_CHANNEL = 'canvas:scene'
export const CANVAS_PRESENCE_CHANNEL = 'canvas:presence'
export const CANVAS_OPEN_REQUEST_CHANNEL = 'canvas:open-request'

/** How long a claim on the board outlives the action that made it. */
const PRESENCE_LINGER_MS = 1_500
/** Editors and git REPLACE a file rather than writing into it, so the directory is watched. */
const WATCH_DEBOUNCE_MS = 150
/** A board nobody is looking at is dropped from memory after this, watcher and all. */
const BOARD_IDLE_MS = 10 * 60 * 1000
/** One log entry for a burst of the person's saves, rather than one per debounce. */
const HUMAN_ACTION_COALESCE_MS = 2_000
/** How long `requestOpen` waits for a window to answer before reporting `revealed: false`. */
const OPEN_REQUEST_WAIT_MS = 3_000
const ACTION_LOG_LIMIT = 50
/**
 * How many readers a board remembers "what changed since you last looked" for.
 *
 * One entry holds a whole scene, and the key is per agent — a long-running
 * project can mint a great many of those. Least recently asked goes first.
 */
const READ_SNAPSHOT_LIMIT = 16
/** A temp file older than this was left by a crash, not by a write in flight. */
const STALE_TEMP_MS = 5 * 60 * 1000

/** `listBoards` walks the project, so it is bounded on every axis. */
const LIST_MAX_DEPTH = 6
/**
 * How many board FILES the walk will look at.
 *
 * Higher than what a listing returns, and deliberately: the answer is the most
 * recently changed boards, and "most recent" cannot be decided by the order a
 * directory walk happens to reach them in. So the walk finds candidates
 * cheaply — a stat each, no parse — and only the ones that survive the sort are
 * opened for their element count.
 */
const LIST_MAX_SCANNED = 2_000
/** Above this a board is summarised from its size alone; parsing it is not worth a list. */
const LIST_MAX_PARSE_BYTES = 5 * 1024 * 1024

// Folders a board never lives in, and which are expensive to walk. Dot-folders
// are skipped wholesale below; these are the ones without a leading dot.
const LIST_SKIP_FOLDERS: ReadonlySet<string> = new Set(['node_modules', 'out', 'dist', 'build'])

/** The screenshot budget, from the plan: a result has to fit the gateway's line limit. */
const SCREENSHOT_DEFAULT_EDGE = 1024
const SCREENSHOT_MAX_EDGE = 1600
const SCREENSHOT_MIN_EDGE = 64
const SCREENSHOT_PNG_BUDGET = 600 * 1024
const SCREENSHOT_JPEG_BUDGET = 900 * 1024
const SCREENSHOT_JPEG_QUALITY = 0.8
const SCREENSHOT_RETRY_SCALE = 0.75

export type CanvasFileStat = {
  size: number
  /** Epoch milliseconds. */
  mtimeMs: number
  isDirectory: boolean
  isFile: boolean
}

export type CanvasDirEntry = {
  name: string
  isDirectory: boolean
  isFile: boolean
}

/**
 * The filesystem as this service needs it. Injected rather than imported so the
 * pipeline's tests run against a map in memory: the interesting behaviour here
 * is ordering and merging, and proving it should not cost a temp directory.
 */
export type CanvasFs = {
  readFile(path: string): Promise<string>
  writeFile(path: string, contents: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Recursive; a no-op when the directory is already there. */
  mkdir(path: string): Promise<void>
  stat(path: string): Promise<CanvasFileStat>
  readdir(path: string): Promise<CanvasDirEntry[]>
  unlink(path: string): Promise<void>
}

export type CanvasDirectoryWatcher = { close(): void }

export type CanvasTimerHandle = { cancel(): void }
export type CanvasSetTimer = (fn: () => void, ms: number) => CanvasTimerHandle

export type CanvasServiceDeps = {
  fs: CanvasFs
  now: () => number
  /** A workspace's project folder from main's registry; null when it has none. */
  resolveWorkspaceRoot: (workspaceId: string) => string | null
  /** Push to every window that could host the workspace (`canvas:open-request`). */
  broadcast: (channel: string, payload: unknown) => void
  /** Push to one subscriber, by the id the IPC layer minted for it. */
  sendTo: (subscriberId: number, channel: string, payload: unknown) => void
  worker: CanvasWorkerHost
  watch: (directory: string, onChange: (filename: string | null) => void) => CanvasDirectoryWatcher
  /** Diagnostics only: nothing here fails because a log line could not be written. */
  log?: (message: string, details?: Record<string, unknown>) => void
  setTimer?: CanvasSetTimer
  /**
   * `process.platform`, injected so both halves of the case rule can be proved.
   * It decides whether two spellings of one path are one board.
   */
  platform?: string
}

/**
 * What `createCanvasService` actually returns: the tools' interface plus the
 * four calls only the IPC layer makes. The tools code against `CanvasService`
 * and cannot reach a subscriber, which is the point of the split.
 */
export type CanvasServiceInternal = CanvasService & {
  openBoard(
    ref: CanvasBoardRef,
    opts: { create?: boolean; subscriberId: number },
  ): Promise<CanvasResult<CanvasBoardState>>
  closeBoard(ref: CanvasBoardRef, subscriberId: number): void
  commitScene(
    input: CanvasBoardRef & {
      baseRevision: number
      elements: CanvasElement[]
      appState: Record<string, unknown>
      files: Record<string, unknown>
    },
    subscriberId: number,
  ): Promise<CanvasResult<{ revision: number; elements: CanvasElement[] | null }>>
  noteHumanInput(ref: CanvasBoardRef, subscriberId?: number): void
  /** A window went away: it stops counting as a subscriber of every board it held. */
  dropSubscriber(subscriberId: number): void
}

type BoardEntry = {
  key: string
  workspaceId: string
  /** Normalized, project-relative. The one spelling everything downstream compares. */
  path: string
  absolutePath: string
  directory: string
  loaded: boolean
  elements: CanvasElement[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
  revision: number
  /**
   * The hash of the file's contents as this service last saw them — whether it
   * wrote them or read them. It is what makes "did somebody else change this?"
   * answerable: the watcher fires on our own atomic write too.
   */
  lastSeenHash: string | null
  /**
   * Somebody else wrote the file and this service has not read it yet.
   *
   * Set the moment the watcher fires, not when its debounce runs: our own write
   * records its hash, so a write landing inside that debounce would leave the
   * reload looking at content it thinks we wrote and dropping the other
   * writer's change on the floor. Every write step settles this first.
   */
  diskDirty: boolean
  /**
   * The size and mtime the file had when this service last read or wrote it.
   *
   * The watcher flag above only closes the window between the OS telling us and
   * the debounce running. This closes the one before that: a change made in the
   * milliseconds before the notification arrives would otherwise be written
   * over, and one `stat` at the head of a write step is nothing next to the
   * write itself.
   */
  lastWrite: { size: number; mtimeMs: number } | null
  subscribers: Set<number>
  presence: CanvasPresence
  presenceTimer: CanvasTimerHandle | null
  actions: CanvasActionEntry[]
  lastHumanAction: { id: string; at: number } | null
  /** Per reader: the elements as they stood when that reader last looked. */
  readSnapshots: Map<string, CanvasElement[]>
  /** The serial queue's tail. Every apply step joins it; worker calls do not. */
  queue: Promise<unknown>
  /** Bumped by every applied change, so a call can tell the board moved under it. */
  mutationSeq: number
  watcher: CanvasDirectoryWatcher | null
  watchDebounce: CanvasTimerHandle | null
  idleTimer: CanvasTimerHandle | null
  lastActivityAt: number
}

const defaultSetTimer: CanvasSetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(timer) }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * A filesystem refusal, in the closed error set. There is no io code in it, and
 * inventing one would mean every layer above learning a new word; `forbidden`
 * is what "the filesystem would not let us" means to a caller, and the OS's own
 * message rides along so the cause is never lost.
 */
function fsFailure<T>(what: string, error: unknown): CanvasResult<T> {
  return canvasFail('forbidden', `${what}: ${errorMessage(error)}`)
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** A fresh `versionNonce`, in the range the file format uses. */
function freshNonce(): number {
  return randomInt(2 ** 31)
}

function boundRefs(element: CanvasElement): CanvasBoundElementRef[] {
  const bound = element.boundElements
  if (!Array.isArray(bound)) return []
  return bound.filter((ref) => typeof ref?.id === 'string')
}

function liveIds(elements: CanvasElement[]): string[] {
  return elements.filter((element) => element.isDeleted !== true).map((element) => element.id)
}

/** The first of a validation's errors, with the rest folded into its message. */
function firstError(errors: CanvasError[]): CanvasError {
  const [head, ...rest] = errors
  if (rest.length === 0) return head
  const shown = rest.slice(0, 4).map((error) => error.message)
  const more = rest.length - shown.length
  const tail = more > 0 ? [...shown, `... and ${more} more.`] : shown
  return { code: head.code, message: [head.message, ...tail].join(' ') }
}

export function createCanvasService(deps: CanvasServiceDeps): CanvasServiceInternal {
  const boards = new Map<string, BoardEntry>()
  const setTimer = deps.setTimer ?? defaultSetTimer
  const log = deps.log ?? (() => {})
  /** Resolved when a subscriber joins a board; how `requestOpen` learns it was answered. */
  const openWaiters = new Map<string, Set<() => void>>()
  let disposed = false
  /** The font warning is said on every write but written to the log once. */
  let fontWarningLogged = false

  const platform = deps.platform ?? process.platform
  // Folded where the filesystem folds it: on darwin and win32 two spellings of
  // one path name one file, and two registry entries over one file would each
  // hold their own revision, their own watcher and their own idea of the scene.
  const boardKey = (workspaceId: string, path: string): string =>
    `${workspaceId}\u0000${canvasBoardKeyPath(path, platform)}`

  type Located = { workspaceId: string; path: string; absolutePath: string; key: string }

  /**
   * A caller's board reference as a place on disk.
   *
   * `normalizeCanvasPath` has already refused anything absolute, anything with
   * a `..`, and anything that is not a board; the containment check after the
   * join is the belt to that braces — it is cheap, and it is the check that
   * still holds if the normalizer ever gains a case it does not cover. Symlinks
   * are deliberately not resolved, which is this tree's rule for containment
   * (see `path-containment.ts`): the question is the path the caller named.
   */
  function locate(ref: CanvasBoardRef): CanvasResult<Located> {
    const workspaceId = typeof ref?.workspaceId === 'string' ? ref.workspaceId.trim() : ''
    if (!workspaceId) return canvasFail('no_workspace', 'This call named no workspace.')
    const normalized = normalizeCanvasPath(ref?.path ?? '')
    if (!normalized.ok) return normalized
    const root = deps.resolveWorkspaceRoot(workspaceId)
    if (!root) {
      return canvasFail(
        'unknown_workspace',
        `Workspace ${workspaceId} is not open, or has no project folder to keep boards in.`,
      )
    }
    const absolutePath = resolvePath(root, normalized.value)
    if (!isPathStrictlyInside(root, absolutePath)) {
      return canvasFail('forbidden', `A board must live inside the project: ${ref.path}`)
    }
    return canvasOk({
      workspaceId,
      path: normalized.value,
      absolutePath,
      key: boardKey(workspaceId, normalized.value),
    })
  }

  function entryFor(located: Located): BoardEntry {
    const existing = boards.get(located.key)
    if (existing) return existing
    const entry: BoardEntry = {
      key: located.key,
      workspaceId: located.workspaceId,
      path: located.path,
      absolutePath: located.absolutePath,
      directory: dirname(located.absolutePath),
      loaded: false,
      elements: [],
      appState: { ...emptyScene().appState },
      files: {},
      revision: 0,
      lastSeenHash: null,
      diskDirty: false,
      lastWrite: null,
      subscribers: new Set(),
      presence: { controller: 'none' },
      presenceTimer: null,
      actions: [],
      lastHumanAction: null,
      readSnapshots: new Map(),
      queue: Promise.resolve(),
      mutationSeq: 0,
      watcher: null,
      watchDebounce: null,
      idleTimer: null,
      lastActivityAt: deps.now(),
    }
    boards.set(located.key, entry)
    return entry
  }

  /**
   * Run `task` in the board's turn.
   *
   * Only the APPLY step of a mutation joins this queue — a worker round trip
   * stays outside it, because a person's save must never wait behind an agent's
   * geometry call. That is the whole reason `edit` has a recompute rule.
   */
  function enqueue<T>(board: BoardEntry, task: () => Promise<T>): Promise<T> {
    const run = board.queue.then(task, task)
    board.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function touch(board: BoardEntry): void {
    board.lastActivityAt = deps.now()
  }

  // ---------------------------------------------------------------- loading

  /**
   * The spelling the board file actually carries on disk.
   *
   * On a case-insensitive filesystem `Arch.excalidraw` and `arch.excalidraw`
   * open the same bytes — but the atomic write ends in a rename, and renaming
   * to the other spelling RENAMES the person's file out from under git. So the
   * directory is read once, when the board is first loaded, and the name on
   * disk wins over the one the caller typed. Elsewhere there is nothing to
   * find and the caller's spelling stands.
   */
  async function adoptDiskSpelling(board: BoardEntry): Promise<void> {
    const cut = board.path.lastIndexOf('/') + 1
    const fileName = board.path.slice(cut)
    let entries: CanvasDirEntry[]
    try {
      entries = await deps.fs.readdir(board.directory)
    } catch {
      // No folder yet, or one we may not read: there is no other spelling.
      return
    }
    const folded = fileName.toLowerCase()
    const onDisk = entries.find(
      (entry) => entry.isFile && entry.name !== fileName && entry.name.toLowerCase() === folded,
    )
    if (!onDisk) return
    board.path = `${board.path.slice(0, cut)}${onDisk.name}`
    board.absolutePath = join(board.directory, onDisk.name)
  }

  /**
   * Temp files a crash left behind.
   *
   * The atomic write is a temp file plus a rename, so a process that dies
   * between the two leaves `<board>.<uuid>.tmp` in the person's project — in
   * their git status, in their file tree, for good. Swept when the board loads,
   * and only the ones old enough to be nobody's write in flight.
   */
  async function sweepStaleTemps(board: BoardEntry): Promise<void> {
    const prefix = `${board.path.slice(board.path.lastIndexOf('/') + 1)}.`
    let entries: CanvasDirEntry[]
    try {
      entries = await deps.fs.readdir(board.directory)
    } catch {
      return
    }
    const now = deps.now()
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) continue
      const absolute = join(board.directory, entry.name)
      try {
        const stat = await deps.fs.stat(absolute)
        if (now - stat.mtimeMs < STALE_TEMP_MS) continue
        await deps.fs.unlink(absolute)
      } catch {
        // Gone already, or not ours to remove. Either way there is nothing to
        // report: this is housekeeping, not part of anybody's call.
      }
    }
  }

  async function loadFromDisk(board: BoardEntry, create: boolean): Promise<CanvasResult<void>> {
    if (canvasPathIsCaseInsensitive(platform)) await adoptDiskSpelling(board)
    await sweepStaleTemps(board)
    let text: string
    try {
      text = await deps.fs.readFile(board.absolutePath)
    } catch (error) {
      if (!isMissing(error)) return fsFailure('The board file could not be read', error)
      if (!create) {
        return canvasFail('not_found', `There is no board at ${board.path}.`)
      }
      const scene = emptyScene()
      board.elements = []
      board.appState = { ...scene.appState }
      board.files = {}
      const written = await writeScene(board)
      if (!written.ok) return written
      board.loaded = true
      return canvasOk(undefined)
    }
    const parsed = parseSceneFile(text)
    // Never repaired by writing: an unreadable file is somebody's work in a
    // format we did not expect, and the one thing worse than refusing to open
    // it is replacing it with an empty scene.
    if (!parsed.ok) return parsed
    board.elements = parsed.value.elements
    board.appState = reduceAppState(parsed.value.appState)
    board.files = parsed.value.files
    board.lastSeenHash = contentHash(text)
    await noteFileStamp(board)
    board.loaded = true
    return canvasOk(undefined)
  }

  async function ensureBoard(ref: CanvasBoardRef, opts: { create?: boolean } = {}): Promise<CanvasResult<BoardEntry>> {
    if (disposed) return canvasFail('worker_unavailable', 'The canvas service is shutting down.')
    const located = locate(ref)
    if (!located.ok) return located
    const board = entryFor(located.value)
    const loaded = await enqueue(board, async () => {
      if (board.loaded) return canvasOk(undefined)
      return loadFromDisk(board, opts.create === true)
    })
    if (!loaded.ok) {
      // A board that never loaded and nobody holds leaves no trace: the next
      // call starts clean rather than inheriting a half-built registry entry.
      if (!board.loaded && board.subscribers.size === 0) dropBoard(board)
      return loaded
    }
    startWatching(board)
    touch(board)
    return canvasOk(board)
  }

  function stateOf(board: BoardEntry): CanvasBoardState {
    return {
      path: board.path,
      revision: board.revision,
      elements: board.elements,
      appState: board.appState,
      files: board.files,
    }
  }

  // ----------------------------------------------------------------- writing

  /**
   * The blobs still referenced by something on the board.
   *
   * `files` is merged add-only on every commit, so an image the person pasted
   * and then deleted would sit in the file for the board's whole life — and a
   * data URL is not a small thing to carry. Tombstones count as references:
   * the element is still there, an undo brings it back, and a blob dropped
   * under a live tombstone would come back as a broken box.
   */
  function referencedFiles(board: BoardEntry): Record<string, unknown> {
    const ids = new Set<string>()
    for (const element of board.elements) {
      const fileId = element.fileId
      if (typeof fileId === 'string' && fileId) ids.add(fileId)
    }
    const kept: Record<string, unknown> = {}
    for (const [id, value] of Object.entries(board.files)) {
      if (ids.has(id)) kept[id] = value
    }
    return kept
  }

  async function writeScene(board: BoardEntry): Promise<CanvasResult<void>> {
    // The last line of defence for a worker answering after the app decided to
    // quit: nothing writes into the person's project once the service is down.
    if (disposed) return canvasFail('worker_unavailable', 'The canvas service is shutting down.')
    board.elements = dropStaleTombstones(board.elements, deps.now())
    board.files = referencedFiles(board)
    const text = serializeSceneFile({
      ...emptyScene(),
      elements: board.elements,
      appState: board.appState,
      files: board.files,
    })
    try {
      await deps.fs.mkdir(board.directory)
    } catch (error) {
      return fsFailure(`The folder for ${board.path} could not be created`, error)
    }
    // The temp file shares the board's directory so the rename is on one
    // filesystem — across devices it is a copy, and a copy is not atomic.
    const temp = `${board.absolutePath}.${randomUUID()}.tmp`
    try {
      await deps.fs.writeFile(temp, text)
      await deps.fs.rename(temp, board.absolutePath)
    } catch (error) {
      await deps.fs.unlink(temp).catch(() => {})
      return fsFailure(`The board ${board.path} could not be written`, error)
    }
    board.lastSeenHash = contentHash(text)
    await noteFileStamp(board)
    return canvasOk(undefined)
  }

  /** Remember the file as it stands, so the next write can tell it apart. */
  async function noteFileStamp(board: BoardEntry): Promise<void> {
    try {
      const stat = await deps.fs.stat(board.absolutePath)
      board.lastWrite = { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      board.lastWrite = null
    }
  }

  /** Has anybody else touched the file since we last looked at it? */
  async function changedOnDisk(board: BoardEntry): Promise<boolean> {
    const stamp = board.lastWrite
    if (!stamp) return false
    try {
      const stat = await deps.fs.stat(board.absolutePath)
      return stat.size !== stamp.size || stat.mtimeMs !== stamp.mtimeMs
    } catch {
      // Gone, or not readable: `reloadFromDisk` handles both quietly, and this
      // is not the place to decide what that means.
      return false
    }
  }

  function pushScene(board: BoardEntry, origin: CanvasScenePush['origin'], exclude?: number): void {
    const payload: CanvasScenePush = {
      workspaceId: board.workspaceId,
      path: board.path,
      revision: board.revision,
      elements: board.elements,
      files: board.files,
      origin,
    }
    for (const subscriberId of board.subscribers) {
      if (subscriberId === exclude) continue
      deps.sendTo(subscriberId, CANVAS_SCENE_CHANNEL, payload)
    }
  }

  function pushPresence(board: BoardEntry, exclude?: number): void {
    const payload = { workspaceId: board.workspaceId, path: board.path, ...board.presence }
    for (const subscriberId of board.subscribers) {
      if (subscriberId === exclude) continue
      deps.sendTo(subscriberId, CANVAS_PRESENCE_CHANNEL, payload)
    }
  }

  /**
   * Somebody holds the pen for a moment.
   *
   * The claim lapses on its own rather than being released, because the thing
   * that would release it is the thing that stopped happening: an agent's last
   * action, or the person's last gesture. Without the timer a badge sticks on
   * screen for as long as the board is open.
   */
  function claim(board: BoardEntry, presence: CanvasPresence, exclude?: number): void {
    board.presence = presence
    pushPresence(board, exclude)
    board.presenceTimer?.cancel()
    board.presenceTimer = setTimer(() => {
      board.presenceTimer = null
      if (boards.get(board.key) !== board) return
      if (board.presence.controller !== presence.controller) return
      board.presence = { controller: 'none' }
      pushPresence(board)
    }, PRESENCE_LINGER_MS)
  }

  // -------------------------------------------------------------- action log

  function beginAction(board: BoardEntry, action: string, summary: string, actor: CanvasActor): CanvasActionEntry {
    const entry: CanvasActionEntry = {
      id: randomUUID(),
      action,
      summary,
      status: 'running',
      actor: actor.kind,
      ...(actor.kind === 'agent' && actor.agentName ? { agentName: actor.agentName } : {}),
      startedAt: deps.now(),
    }
    board.actions.push(entry)
    if (board.actions.length > ACTION_LOG_LIMIT) board.actions.splice(0, board.actions.length - ACTION_LOG_LIMIT)
    return entry
  }

  function finishAction(
    entry: CanvasActionEntry,
    status: CanvasActionEntry['status'],
    detail?: { summary?: string; error?: string },
  ): void {
    entry.status = status
    entry.completedAt = deps.now()
    if (detail?.summary) entry.summary = detail.summary
    if (detail?.error) entry.error = detail.error
  }

  /**
   * The person's saves arrive on a ~400 ms debounce, so one drawn box is
   * several of them. The log says "the person edited the board" once for a
   * burst rather than filling its fifty lines with one gesture.
   */
  function recordHumanAction(board: BoardEntry, summary: string): void {
    const at = deps.now()
    const last = board.lastHumanAction
    if (last && at - last.at < HUMAN_ACTION_COALESCE_MS) {
      const existing = board.actions.find((entry) => entry.id === last.id)
      if (existing) {
        existing.summary = summary
        existing.completedAt = at
        board.lastHumanAction = { id: last.id, at }
        return
      }
    }
    const entry = beginAction(board, 'canvas.commit', summary, { kind: 'human' })
    finishAction(entry, 'succeeded')
    board.lastHumanAction = { id: entry.id, at }
  }

  // ---------------------------------------------------------------- watching

  function startWatching(board: BoardEntry): void {
    if (board.watcher || disposed) return
    const fileName = board.path.slice(board.path.lastIndexOf('/') + 1)
    try {
      // The DIRECTORY, not the file: an editor and a git checkout both replace
      // a board rather than writing into it, and a watch on the old inode goes
      // quiet the moment they do.
      board.watcher = deps.watch(board.directory, (changed) => {
        // `fs.watch` may report no name at all; when it does report one, only
        // this board's own file (and its atomic temp) is our business.
        if (changed !== null && changed !== fileName && !changed.startsWith(`${fileName}.`)) return
        // Marked now, reloaded later: the debounce coalesces a burst of events
        // into one read, and this is what stops a write of ours inside that
        // window from swallowing the change that caused them.
        board.diskDirty = true
        board.watchDebounce?.cancel()
        board.watchDebounce = setTimer(() => {
          board.watchDebounce = null
          void enqueue(board, async () => {
            await reloadFromDisk(board)
          })
        }, WATCH_DEBOUNCE_MS)
      })
    } catch (error) {
      // A project on a filesystem without change notification still works; it
      // just does not hear about an edit made outside the app.
      log('A canvas board could not be watched for changes', { path: board.path, error: errorMessage(error) })
    }
  }

  /**
   * A change we did not make. The disk is another peer's view of the same
   * board, so it is merged rather than applied: for one id the higher version
   * wins and a tie goes to the disk, because a scene file is a COMPLETE scene —
   * an element missing from it was deleted there, and is tombstoned here so
   * every open editor converges on the same drawing.
   */
  async function reloadFromDisk(board: BoardEntry): Promise<'settled' | 'unparseable'> {
    if (boards.get(board.key) !== board || !board.loaded) return 'settled'
    // Cleared before the read, never after: an event that arrives while this
    // one is reading is about content this read may not have seen.
    board.diskDirty = false
    let text: string
    try {
      text = await deps.fs.readFile(board.absolutePath)
    } catch (error) {
      // Deleted under us (a branch switch, a rename): memory is still the
      // person's drawing, and the next write puts the file back, so this is a
      // quiet no-op rather than an emptied board.
      if (isMissing(error)) return 'settled'
      log('A canvas board could not be re-read after a change', { path: board.path, error: errorMessage(error) })
      return 'settled'
    }
    const hash = contentHash(text)
    if (hash === board.lastSeenHash) {
      await noteFileStamp(board)
      return 'settled'
    }
    const parsed = parseSceneFile(text)
    if (!parsed.ok) {
      // Half-written, most likely: another writer is mid-save and the watcher
      // saw the file between its bytes. Memory stands, the board stays dirty so
      // the next write step looks again, and nothing is written over it.
      board.diskDirty = true
      log('A canvas board changed on disk into something unreadable', {
        path: board.path,
        detail: parsed.error.message,
      })
      return 'unparseable'
    }
    const merged = mergeFromDisk(board.elements, parsed.value.elements, deps.now())
    board.elements = merged
    board.appState = reduceAppState(parsed.value.appState)
    board.files = { ...board.files, ...parsed.value.files }
    board.lastSeenHash = hash
    await noteFileStamp(board)
    board.revision += 1
    board.mutationSeq += 1
    touch(board)
    pushScene(board, 'disk')
    return 'settled'
  }

  /**
   * Read anybody else's pending change before writing over it.
   *
   * A write step runs in the board's turn, so this is the last moment at which
   * the two versions can still be merged rather than one of them lost.
   *
   * A file that is unreadable AT THAT MOMENT stops the write. It is nearly
   * always another program mid-save, and the next attempt goes through — but
   * the alternative is replacing whatever somebody hand-edited into the file
   * with our own idea of the board, and a scene file this app cannot parse is
   * never overwritten, on this path as on the load path.
   */
  async function settleDisk(board: BoardEntry): Promise<CanvasResult<void>> {
    if (!board.diskDirty && !(await changedOnDisk(board))) return canvasOk(undefined)
    const state = await reloadFromDisk(board)
    if (state === 'unparseable') {
      return canvasFail(
        'invalid_scene',
        `${board.path} has been changed on disk into something this app cannot read, so nothing was written and that file is untouched. Fix or revert it and try again.`,
      )
    }
    return canvasOk(undefined)
  }

  function armIdleSweep(board: BoardEntry): void {
    board.idleTimer?.cancel()
    board.idleTimer = setTimer(() => {
      board.idleTimer = null
      if (boards.get(board.key) !== board) return
      if (board.subscribers.size > 0) return
      if (deps.now() - board.lastActivityAt < BOARD_IDLE_MS) {
        armIdleSweep(board)
        return
      }
      dropBoard(board)
    }, BOARD_IDLE_MS)
  }

  function dropBoard(board: BoardEntry): void {
    board.watchDebounce?.cancel()
    board.presenceTimer?.cancel()
    board.idleTimer?.cancel()
    try {
      board.watcher?.close()
    } catch {
      // A watcher already closed by its own error path; nothing to undo.
    }
    board.watcher = null
    if (boards.get(board.key) === board) boards.delete(board.key)
  }

  // ------------------------------------------------------------ the pipeline

  type ApplyOutcome = {
    elements: CanvasElement[]
    files?: Record<string, unknown>
  }

  /**
   * The shared tail of every agent mutation: merge what the worker produced
   * into whatever the board is NOW, write it, bump the revision and tell the
   * windows. Runs inside the board's turn.
   */
  async function applyAgentWrite(
    board: BoardEntry,
    outcome: ApplyOutcome,
    actor: CanvasActor,
    touched: string[],
  ): Promise<CanvasResult<void>> {
    if (disposed) return canvasFail('worker_unavailable', 'The canvas service is shutting down.')
    const before = board.elements
    const beforeFiles = board.files
    board.elements = dropStaleTombstones(
      repairBindingPairs(mergeElements(board.elements, outcome.elements)),
      deps.now(),
    )
    if (outcome.files) board.files = { ...board.files, ...outcome.files }
    const written = await writeScene(board)
    if (!written.ok) {
      // All of it, not only the elements: a rollback that leaves the merged
      // blobs behind writes them out on the next successful save, under a
      // scene that never referred to them.
      board.elements = before
      board.files = beforeFiles
      return written
    }
    board.revision += 1
    board.mutationSeq += 1
    touch(board)
    pushScene(board, 'agent')
    if (actor.kind === 'agent') {
      claim(board, {
        controller: 'agent',
        ...(actor.agentName ? { agentName: actor.agentName } : {}),
        selectedElementIds: touched,
      })
    }
    // An agent that just wrote has seen the board it wrote: its next
    // "what changed since I looked" is about the person, not about itself.
    // Through the shared key helper, because the tools ASK under that spelling
    // and a snapshot filed under any other is a snapshot nobody ever reads.
    if (actor.kind === 'agent' && actor.agentId) {
      rememberRead(board, canvasReaderKey(actor.workspaceId, actor.agentId), board.elements)
    }
    return canvasOk(undefined)
  }

  /**
   * Did the board move under an in-flight worker call in a way that matters?
   *
   * The elements at stake are every one whose VERSION the worker moved, not
   * only the ones the edit named. Fastening an arrow to a box bumps the box
   * too — it gains the arrow in `boundElements` — and if that is not counted,
   * a person dragging that box at the same moment produces two elements at the
   * same version from the same base, and the nonce tie-break decides whose
   * work survives by coin toss. A person drawing elsewhere still merges
   * cleanly: the merge keeps ids only one side has.
   */
  function contested(board: BoardEntry, base: CanvasElement[], atStake: Iterable<string>): boolean {
    const baseById = new Map(base.map((element) => [element.id, element]))
    const currentById = new Map(board.elements.map((element) => [element.id, element]))
    for (const id of atStake) {
      const was = baseById.get(id)
      const now = currentById.get(id)
      if (!was || !now) continue
      if (was.version !== now.version || was.versionNonce !== now.versionNonce) return true
    }
    return false
  }

  /**
   * The other half of every binding, after a merge.
   *
   * A binding is a PAIR of references — the arrow names the shape, the shape
   * lists the arrow — and the merge decides per ELEMENT, so the two halves can
   * come from different writers. A shape the person moved while an agent
   * fastened an arrow to it wins the merge outright, `boundElements` and all,
   * and the arrow is then listed nowhere: it follows the shape, but dragging
   * the shape leaves it behind, and the one-way binding that results is one no
   * skeleton edit can clear.
   *
   * Only the MISSING half is ever added, never removed, which is what makes
   * this safe to run on every write. Somebody who detached an arrow cleared the
   * arrow's own binding too, so there is nothing here to add back; a shape
   * listing an arrow that binds it nowhere is left for the lint to report,
   * because removing it could undo an edit still in flight.
   *
   * A repaired shape takes a version above its own, so the writer whose copy
   * won hears about it on the answer to its own write rather than sending the
   * half-binding back and undoing the repair.
   */
  function repairBindingPairs(elements: CanvasElement[]): CanvasElement[] {
    const live = new Map<string, CanvasElement>()
    for (const element of elements) {
      if (element.isDeleted !== true) live.set(element.id, element)
    }
    const additions = new Map<string, CanvasBoundElementRef[]>()
    const want = (hostId: string, ref: CanvasBoundElementRef): void => {
      const host = live.get(hostId)
      if (!host) return
      const listed = boundRefs(host).map((entry) => entry.id)
      const pending = additions.get(hostId) ?? []
      if (listed.includes(ref.id) || pending.some((entry) => entry.id === ref.id)) return
      additions.set(hostId, [...pending, ref])
    }

    for (const element of live.values()) {
      for (const which of ['startBinding', 'endBinding'] as const) {
        const binding = element[which]
        const targetId =
          typeof binding === 'object' &&
          binding !== null &&
          typeof (binding as { elementId?: unknown }).elementId === 'string'
            ? (binding as { elementId: string }).elementId
            : null
        if (targetId) want(targetId, { id: element.id, type: 'arrow' })
      }
      if (element.type === 'text' && typeof element.containerId === 'string' && element.containerId) {
        want(element.containerId, { id: element.id, type: 'text' })
      }
    }
    if (additions.size === 0) return elements

    const now = deps.now()
    return elements.map((element) => {
      const extra = additions.get(element.id)
      if (!extra || element.isDeleted === true) return element
      const next: CanvasElement = {
        ...element,
        boundElements: [...boundRefs(element), ...extra],
        version: (typeof element.version === 'number' ? element.version : 0) + 1,
        versionNonce: freshNonce(),
        updated: now,
      }
      return next
    })
  }

  /**
   * The ids a worker's output moved, read off the output itself.
   *
   * Belt to the worker's own `changed` list's braces: the worker hands back the
   * element it was given, unchanged, for anything it did not touch, so a
   * version that differs from the base is a write whether or not the worker
   * remembered to say so. Only elements present in BOTH count — a create is not
   * a collision with anything.
   */
  function bumpedAgainstBase(base: CanvasElement[], produced: CanvasElement[]): string[] {
    const baseById = new Map(base.map((element) => [element.id, element]))
    const out: string[] = []
    for (const element of produced) {
      const was = baseById.get(element.id)
      if (!was) continue
      if (was.version !== element.version || was.versionNonce !== element.versionNonce) out.push(element.id)
    }
    return out
  }

  async function runAgentMutation<T>(
    board: BoardEntry,
    action: string,
    actor: CanvasActor,
    compute: (
      base: CanvasElement[],
      files: Record<string, unknown>,
    ) => Promise<
      CanvasResult<{
        outcome: ApplyOutcome
        /** What the agent asked for: the presence badge's selection. */
        touched: string[]
        /** Every id the worker's own bookkeeping says it moved. Optional: the
         *  output is re-read against the base regardless. */
        changed?: string[]
        value: T
        summary: string
      }>
    >,
  ): Promise<CanvasResult<T>> {
    const entry = beginAction(board, action, 'in progress', actor)
    let attempts = 0
    for (;;) {
      const base = board.elements
      const seq = board.mutationSeq
      const computed = await compute(base, board.files)
      if (!computed.ok) {
        finishAction(entry, 'failed', { summary: computed.error.code, error: computed.error.message })
        return computed
      }
      const atStake = new Set([
        ...computed.value.touched,
        ...(computed.value.changed ?? []),
        ...bumpedAgainstBase(base, computed.value.outcome.elements),
      ])
      const applied = await enqueue(board, async (): Promise<CanvasResult<T> | 'retry'> => {
        // Before the collision test, not after: a change read off the disk here
        // bumps the board's sequence, and an element it brings that this edit
        // also touches is a collision like any other.
        const settled = await settleDisk(board)
        if (!settled.ok) return settled
        if (board.mutationSeq !== seq && contested(board, base, atStake)) return 'retry'
        const write = await applyAgentWrite(board, computed.value.outcome, actor, computed.value.touched)
        if (!write.ok) return write
        return canvasOk(computed.value.value)
      })
      if (applied !== 'retry') {
        if (applied.ok) finishAction(entry, 'succeeded', { summary: computed.value.summary })
        else finishAction(entry, 'failed', { summary: applied.error.code, error: applied.error.message })
        return applied
      }
      attempts += 1
      if (attempts > 1) {
        // Twice in a row means the person is drawing on exactly what the agent
        // is editing. They win; the agent is told plainly rather than made to
        // fight for the element.
        const error = {
          code: 'interrupted' as const,
          message: 'The person edited the same elements while this ran. Read the board again and retry.',
        }
        finishAction(entry, 'interrupted', { summary: 'interrupted', error: error.message })
        return { ok: false, error }
      }
    }
  }

  /**
   * The one degradation an agent cannot see and the person can.
   *
   * The worker answers after a deadline whether or not the scene fonts
   * arrived. If they did not, every label it measures is measured in whatever
   * face the browser substituted, and those numbers are written into the
   * person's file — a board whose boxes are all slightly the wrong size, with
   * nothing anywhere to say why. So every write made in that state says so.
   */
  function fontWarning(): string | null {
    const report = deps.worker.report()
    if (!report || report.missing.length === 0) return null
    if (!fontWarningLogged) {
      fontWarningLogged = true
      log('The canvas worker is measuring text in a fallback font', {
        missing: report.missing.join(', '),
        errors: report.errors.join(' '),
      })
    }
    return `Text was measured with a fallback font: the board's own ${report.missing.join(', ')} did not load, so label sizes may be a little off. Restart the app if the text looks wrong.`
  }

  function withFontWarning(warnings: string[]): string[] {
    const warning = fontWarning()
    return warning ? [...warnings, warning] : warnings
  }

  // ------------------------------------------------------------------ boards

  async function listBoards(workspaceId: string): Promise<CanvasResult<CanvasBoardSummary[]>> {
    const id = typeof workspaceId === 'string' ? workspaceId.trim() : ''
    if (!id) return canvasFail('no_workspace', 'This call named no workspace.')
    const root = deps.resolveWorkspaceRoot(id)
    if (!root) {
      return canvasFail('unknown_workspace', `Workspace ${id} is not open, or has no project folder to keep boards in.`)
    }
    const found: FoundBoard[] = []
    await walk(root, root, 0, found)
    // Newest first, and only THEN capped: the walk's own order is the
    // filesystem's, and capping on that would hide the board somebody edited a
    // minute ago behind two hundred they have not opened in a year.
    found.sort((a, b) => b.modifiedAt - a.modifiedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const shown = found.slice(0, CANVAS_LIST_MAX_BOARDS)
    return canvasOk(
      await Promise.all(
        shown.map(async (board) => ({
          path: board.path,
          name: canvasBoardName(board.path),
          elementCount: await countElements(board.absolutePath, board.size),
          modifiedAt: board.modifiedAt,
        })),
      ),
    )
  }

  /** A candidate from the walk: everything but the element count, which costs a parse. */
  type FoundBoard = { path: string; absolutePath: string; modifiedAt: number; size: number }

  async function walk(root: string, directory: string, depth: number, found: FoundBoard[]): Promise<void> {
    if (depth > LIST_MAX_DEPTH || found.length >= LIST_MAX_SCANNED) return
    let entries: CanvasDirEntry[]
    try {
      entries = await deps.fs.readdir(directory)
    } catch {
      // An unreadable folder is not an error for a listing; it just has no
      // boards anyone can open.
      return
    }
    const folders: string[] = []
    for (const entry of entries) {
      if (found.length >= LIST_MAX_SCANNED) return
      if (entry.isDirectory) {
        // Dot-folders wholesale: `.git`, `.sprintengine`, `.multi-code` and
        // every other tool's store are not where a person keeps a drawing.
        if (entry.name.startsWith('.')) continue
        if (LIST_SKIP_FOLDERS.has(entry.name)) continue
        folders.push(entry.name)
        continue
      }
      if (!entry.isFile || !entry.name.endsWith(CANVAS_FILE_EXTENSION)) continue
      const absolute = join(directory, entry.name)
      const projectPath = relative(root, absolute).split('\\').join('/')
      let stat: CanvasFileStat
      try {
        stat = await deps.fs.stat(absolute)
      } catch {
        continue
      }
      found.push({ path: projectPath, absolutePath: absolute, modifiedAt: stat.mtimeMs, size: stat.size })
    }
    for (const folder of folders) {
      if (found.length >= LIST_MAX_SCANNED) return
      await walk(root, join(directory, folder), depth + 1, found)
    }
  }

  /** `-1` means "not counted": the file is too big to parse for a picker row. */
  async function countElements(absolutePath: string, size: number): Promise<number> {
    if (size > LIST_MAX_PARSE_BYTES) return -1
    try {
      const parsed = parseSceneFile(await deps.fs.readFile(absolutePath))
      return parsed.ok ? parsed.value.elements.filter((element) => element.isDeleted !== true).length : -1
    } catch {
      return -1
    }
  }

  // ------------------------------------------------------------------- calls

  async function readBoard(
    ref: CanvasBoardRef,
    opts: { create?: boolean } = {},
  ): Promise<CanvasResult<CanvasBoardState>> {
    const board = await ensureBoard(ref, opts)
    if (!board.ok) return board
    return canvasOk(stateOf(board.value))
  }

  async function edit(
    ref: CanvasBoardRef,
    request: CanvasEditRequest,
    actor: CanvasActor,
  ): Promise<CanvasResult<{ state: CanvasBoardState; result: CanvasEditResult }>> {
    const board = await ensureBoard(ref, { create: true })
    if (!board.ok) return board
    const entry = board.value
    const errors = validateEditRequest(request, liveIds(entry.elements))
    if (errors.length > 0) return { ok: false, error: firstError(errors) }

    const applied = await runAgentMutation(entry, 'canvas.edit', actor, async (base, files) => {
      const response = await deps.worker.call({ kind: 'apply-edit', elements: base, files, edit: request })
      if (!response.ok) return response
      const result = response.value.result
      return canvasOk({
        outcome: { elements: response.value.elements, files: response.value.files },
        touched: [...result.updated, ...result.deleted],
        changed: response.value.changed,
        value: {
          created: result.created,
          updated: result.updated,
          deleted: result.deleted,
          tempIds: result.tempIds,
          warnings: withFontWarning(result.warnings),
        },
        summary: `created ${result.created.length}, updated ${result.updated.length}, deleted ${result.deleted.length}`,
      })
    })
    if (!applied.ok) return applied
    // The lint is attached AFTER the write, against the board as it now
    // stands: an agent that acts on it is acting on what everyone can see.
    return canvasOk({
      state: stateOf(entry),
      result: { ...applied.value, lint: lintScene(entry.elements) } satisfies CanvasEditResult,
    })
  }

  async function layout(
    ref: CanvasBoardRef,
    request: CanvasLayoutRequest,
    actor: CanvasActor,
  ): Promise<CanvasResult<{ state: CanvasBoardState; warnings: string[] }>> {
    const board = await ensureBoard(ref)
    if (!board.ok) return board
    const entry = board.value
    if (!request || typeof request.op !== 'string' || !Array.isArray(request.elementIds)) {
      return canvasFail('invalid_edit', 'A layout needs an op and the elements to apply it to.')
    }
    const known = new Set(liveIds(entry.elements))
    const missing = request.elementIds.filter((id) => typeof id !== 'string' || !known.has(id))
    if (missing.length > 0) {
      return canvasFail('unknown_element', `These elements are not on this board: ${missing.join(', ')}`)
    }
    const applied = await runAgentMutation(entry, 'canvas.layout', actor, async (base, _files) => {
      const response = await deps.worker.call({ kind: 'layout', elements: base, request })
      if (!response.ok) return response
      return canvasOk({
        outcome: { elements: response.value.elements },
        touched: request.elementIds,
        changed: response.value.changed,
        // Carried out rather than swallowed: an align that moved nothing
        // because the elements are freehand strokes is a result the agent has
        // to see, or it will believe the board is straight.
        value: withFontWarning(response.value.warnings ?? []),
        summary: `${request.op} over ${request.elementIds.length} element(s)`,
      })
    })
    if (!applied.ok) return applied
    return canvasOk({ state: stateOf(entry), warnings: applied.value })
  }

  async function importContent(
    ref: CanvasBoardRef,
    request: CanvasImportRequest,
    actor: CanvasActor,
  ): Promise<CanvasResult<{ state: CanvasBoardState; result: CanvasEditResult }>> {
    const board = await ensureBoard(ref, { create: true })
    if (!board.ok) return board
    const entry = board.value
    const mode = request?.mode === 'replace' ? 'replace' : 'merge'
    const hasMermaid = typeof request?.mermaid === 'string' && request.mermaid.trim().length > 0
    const hasScene = request?.scene !== undefined && request.scene !== null
    if (hasMermaid === hasScene) {
      return canvasFail(
        'invalid_edit',
        'An import takes either a mermaid definition or a scene, not both and not neither.',
      )
    }

    const applied = await runAgentMutation(entry, 'canvas.import', actor, async (base, _files) => {
      const response = hasMermaid
        ? await deps.worker.call({ kind: 'import-mermaid', definition: request.mermaid as string })
        : await deps.worker.call({ kind: 'import-scene', scene: request.scene })
      if (!response.ok) return response
      const incoming = response.value.elements
      const imported = incoming.map((element) => element.id)
      // `replace` TOMBSTONES what was there rather than dropping it. A drop
      // would be invisible to an open editor — it holds those elements alive
      // and would merge them straight back on its next save.
      const cleared =
        mode === 'replace'
          ? base
              .filter((element) => element.isDeleted !== true)
              .map((element) => ({
                ...element,
                isDeleted: true,
                version: (typeof element.version === 'number' ? element.version : 0) + 1,
                updated: deps.now(),
              }))
          : []
      return canvasOk({
        outcome: { elements: [...cleared, ...incoming], files: response.value.files },
        touched: cleared.map((element) => element.id),
        value: {
          created: imported,
          updated: [],
          deleted: cleared.map((element) => element.id),
          tempIds: {},
          warnings: withFontWarning([]),
        } satisfies CanvasEditResult,
        summary: `${mode} import of ${imported.length} element(s)`,
      })
    })
    if (!applied.ok) return applied
    return canvasOk({
      state: stateOf(entry),
      result: { ...applied.value, lint: lintScene(entry.elements) },
    })
  }

  async function screenshot(
    ref: CanvasBoardRef,
    opts: { elementIds?: string[]; maxEdge?: number; background?: boolean; dark?: boolean },
  ): Promise<CanvasResult<CanvasImage>> {
    const board = await ensureBoard(ref)
    if (!board.ok) return board
    const entry = board.value
    const wanted = Array.isArray(opts?.elementIds) && opts.elementIds.length > 0 ? new Set(opts.elementIds) : null
    const subject = entry.elements.filter(
      (element) => element.isDeleted !== true && (!wanted || wanted.has(element.id)),
    )
    if (subject.length === 0) {
      return canvasFail(
        'invalid_scene',
        wanted
          ? 'None of those elements are on this board; there is nothing to capture.'
          : 'The board is empty; there is nothing to capture.',
      )
    }
    const requested =
      typeof opts?.maxEdge === 'number' && Number.isFinite(opts.maxEdge)
        ? Math.round(opts.maxEdge)
        : SCREENSHOT_DEFAULT_EDGE
    // The caller may ask for less. It may not ask for more than the ceiling:
    // the answer has to fit one line of the gateway's protocol, whoever asked.
    const maxEdge = Math.max(SCREENSHOT_MIN_EDGE, Math.min(requested, SCREENSHOT_MAX_EDGE))
    const base = {
      // Live elements only: a tombstone is not drawable, and the whole live
      // scene goes even when a subset is framed, so an arrow bound to a shape
      // outside the frame still knows where it is pointing.
      elements: entry.elements.filter((element) => element.isDeleted !== true),
      appState: entry.appState,
      files: entry.files,
      ...(wanted ? { elementIds: [...wanted] } : {}),
      background: opts?.background !== false,
      dark: opts?.dark === true,
    }

    const png = await deps.worker.call({ kind: 'export-image', ...base, maxEdge, format: 'png' })
    if (!png.ok) return png
    if (png.value.image.data.length <= SCREENSHOT_PNG_BUDGET) return canvasOk(png.value.image)

    const jpeg = await deps.worker.call({
      ...base,
      kind: 'export-image',
      maxEdge,
      format: 'jpeg',
      quality: SCREENSHOT_JPEG_QUALITY,
    })
    if (!jpeg.ok) return jpeg
    if (jpeg.value.image.data.length <= SCREENSHOT_JPEG_BUDGET) return canvasOk(jpeg.value.image)

    const smallerEdge = Math.max(SCREENSHOT_MIN_EDGE, Math.round(maxEdge * SCREENSHOT_RETRY_SCALE))
    const smaller = await deps.worker.call({
      ...base,
      kind: 'export-image',
      maxEdge: smallerEdge,
      format: 'jpeg',
      quality: SCREENSHOT_JPEG_QUALITY,
    })
    if (!smaller.ok) return smaller
    if (smaller.value.image.data.length <= SCREENSHOT_JPEG_BUDGET) return canvasOk(smaller.value.image)
    return canvasFail(
      'too_large',
      'This board does not fit in one image at a readable size. Capture a frame or a selection instead.',
    )
  }

  async function requestOpen(ref: CanvasBoardRef): Promise<CanvasResult<{ revealed: boolean }>> {
    const located = locate(ref)
    if (!located.ok) return located
    const existing = boards.get(located.value.key)
    // The spelling the FILE has, when the board is loaded and knows it: a tab
    // opened under the caller's spelling would be titled something the project
    // does not contain.
    const path = existing?.loaded ? existing.path : located.value.path
    if (existing && existing.subscribers.size > 0) {
      deps.broadcast(CANVAS_OPEN_REQUEST_CHANNEL, { workspaceId: located.value.workspaceId, path })
      return canvasOk({ revealed: true })
    }
    const revealed = await new Promise<boolean>((settle) => {
      const waiters = openWaiters.get(located.value.key) ?? new Set<() => void>()
      openWaiters.set(located.value.key, waiters)
      let done = false
      const finish = (answer: boolean): void => {
        if (done) return
        done = true
        waiters.delete(waiter)
        if (waiters.size === 0) openWaiters.delete(located.value.key)
        timer.cancel()
        settle(answer)
      }
      const waiter = (): void => finish(true)
      waiters.add(waiter)
      const timer = setTimer(() => finish(false), OPEN_REQUEST_WAIT_MS)
      // Broadcast only once the waiter is in place: a window that answers in
      // the same tick must not find nobody listening.
      deps.broadcast(CANVAS_OPEN_REQUEST_CHANNEL, { workspaceId: located.value.workspaceId, path })
    })
    // Never an error: "no window answered" is an answer, and a headless run is
    // a supported way to use every one of these tools.
    return canvasOk({ revealed })
  }

  function changesSinceLastRead(ref: CanvasBoardRef, readerKey: string): string[] {
    const located = locate(ref)
    if (!located.ok) return []
    const board = boards.get(located.value.key)
    if (!board || !board.loaded) return []
    const key = typeof readerKey === 'string' && readerKey.length > 0 ? readerKey : 'anonymous'
    const previous = board.readSnapshots.get(key)
    rememberRead(board, key, board.elements)
    // The first look has nothing to be a change from; saying so beats
    // reporting the whole board as new.
    if (!previous) return []
    return summariseChanges(previous, board.elements)
  }

  /**
   * File this reader's snapshot, dropping the least recently used one when the
   * board is holding too many. A Map iterates in insertion order, so deleting
   * before setting is what keeps "most recent" at the end.
   */
  function rememberRead(board: BoardEntry, key: string, elements: CanvasElement[]): void {
    board.readSnapshots.delete(key)
    board.readSnapshots.set(key, elements)
    while (board.readSnapshots.size > READ_SNAPSHOT_LIMIT) {
      const oldest = board.readSnapshots.keys().next()
      if (oldest.done) break
      board.readSnapshots.delete(oldest.value)
    }
  }

  function actions(ref: CanvasBoardRef): CanvasActionEntry[] {
    const located = locate(ref)
    if (!located.ok) return []
    return boards.get(located.value.key)?.actions.slice() ?? []
  }

  // ------------------------------------------------------- the pane's half

  async function openBoard(
    ref: CanvasBoardRef,
    opts: { create?: boolean; subscriberId: number },
  ): Promise<CanvasResult<CanvasBoardState>> {
    const board = await ensureBoard(ref, { create: opts.create === true })
    if (!board.ok) return board
    const entry = board.value
    entry.subscribers.add(opts.subscriberId)
    entry.idleTimer?.cancel()
    entry.idleTimer = null
    touch(entry)
    for (const waiter of [...(openWaiters.get(entry.key) ?? [])]) waiter()
    return canvasOk(stateOf(entry))
  }

  function closeBoard(ref: CanvasBoardRef, subscriberId: number): void {
    const located = locate(ref)
    if (!located.ok) return
    const board = boards.get(located.value.key)
    if (!board) return
    board.subscribers.delete(subscriberId)
    if (board.subscribers.size === 0) armIdleSweep(board)
  }

  function dropSubscriber(subscriberId: number): void {
    for (const board of boards.values()) {
      if (!board.subscribers.delete(subscriberId)) continue
      if (board.subscribers.size === 0) armIdleSweep(board)
    }
  }

  async function commitScene(
    input: CanvasBoardRef & {
      baseRevision: number
      elements: CanvasElement[]
      appState: Record<string, unknown>
      files: Record<string, unknown>
    },
    subscriberId: number,
  ): Promise<CanvasResult<{ revision: number; elements: CanvasElement[] | null }>> {
    const board = await ensureBoard(input, { create: true })
    if (!board.ok) return board
    const entry = board.value
    // `baseRevision` is not read, and that is the design rather than an
    // oversight: the merge is per element, so what the tab last saw does not
    // change what survives. It stays on the wire because the ANSWER is about
    // it — a tab whose base is behind is told so by getting elements back.
    return enqueue(entry, async () => {
      if (disposed) return canvasFail('worker_unavailable', 'The canvas service is shutting down.')
      const settled = await settleDisk(entry)
      if (!settled.ok) return settled
      const before = entry.elements
      const beforeFiles = entry.files
      const beforeAppState = entry.appState
      const merged = dropStaleTombstones(repairBindingPairs(mergeElements(entry.elements, input.elements)), deps.now())
      entry.elements = merged
      entry.appState = reduceAppState(input.appState)
      // Binary blobs are add-only in an editor session: merging by key keeps an
      // image an agent added and an image the person pasted in the same board.
      entry.files = { ...entry.files, ...input.files }
      const written = await writeScene(entry)
      if (!written.ok) {
        entry.elements = before
        entry.files = beforeFiles
        entry.appState = beforeAppState
        return written
      }
      entry.revision += 1
      entry.mutationSeq += 1
      touch(entry)
      recordHumanAction(
        entry,
        `${merged.filter((element) => element.isDeleted !== true).length} element(s) on the board`,
      )
      // The sender already has what it sent; echoing it back would fight the
      // person's own cursor. Every OTHER window hears about it.
      pushScene(entry, 'human', subscriberId)
      // Non-null only when the merge produced something other than what the
      // tab sent — that, and only that, is the tab's cue to reconcile.
      const differs = sceneVersionHash(entry.elements) !== sceneVersionHash(input.elements)
      return canvasOk({ revision: entry.revision, elements: differs ? entry.elements : null })
    })
  }

  function noteHumanInput(ref: CanvasBoardRef, subscriberId?: number): void {
    const located = locate(ref)
    if (!located.ok) return
    const board = boards.get(located.value.key)
    if (!board) return
    touch(board)
    // The window the person is drawing in already knows; the others are the
    // ones that need to stop showing an agent holding the pen.
    claim(board, { controller: 'human' }, subscriberId)
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    const entries = [...boards.values()]
    // Let whatever is mid-write finish: a board dropped between its temp file
    // and its rename would leave the project with a stray `.tmp`.
    await Promise.all(entries.map((board) => board.queue.catch(() => undefined)))
    for (const board of entries) dropBoard(board)
    boards.clear()
    openWaiters.clear()
    await deps.worker.dispose()
  }

  return {
    listBoards,
    readBoard,
    edit,
    layout,
    importContent,
    screenshot,
    requestOpen,
    changesSinceLastRead,
    actions,
    dispose,
    openBoard,
    closeBoard,
    commitScene,
    noteHumanInput,
    dropSubscriber,
  }
}

/**
 * Merge a board file somebody else wrote into what is in memory.
 *
 * Not `mergeElements`: this side is not a peer's partial view but a WHOLE
 * scene, so absence means deletion. An id the disk no longer carries is
 * tombstoned with a bumped version, which is the same deletion every other
 * subscriber will merge; a tie on version goes to the disk, because the disk is
 * what a person just looked at in another program.
 */
export function mergeFromDisk(local: CanvasElement[], disk: CanvasElement[], now: number): CanvasElement[] {
  const diskById = new Map<string, CanvasElement>()
  for (const element of disk) if (!diskById.has(element.id)) diskById.set(element.id, element)

  const merged: CanvasElement[] = []
  const seen = new Set<string>()
  for (const element of local) {
    if (seen.has(element.id)) continue
    seen.add(element.id)
    const fromDisk = diskById.get(element.id)
    if (!fromDisk) {
      merged.push(
        element.isDeleted === true
          ? element
          : { ...element, isDeleted: true, version: (element.version ?? 0) + 1, updated: now },
      )
      continue
    }
    const localVersion = typeof element.version === 'number' ? element.version : 0
    const diskVersion = typeof fromDisk.version === 'number' ? fromDisk.version : 0
    merged.push(diskVersion >= localVersion ? fromDisk : element)
  }
  for (const element of disk) {
    if (seen.has(element.id)) continue
    seen.add(element.id)
    merged.push(element)
  }
  return merged
}
