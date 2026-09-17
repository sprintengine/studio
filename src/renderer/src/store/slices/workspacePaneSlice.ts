import { nanoid } from 'nanoid'
import { BROWSER_MAX_RECENT_URLS } from '../../../../shared/browser'
import { normalizeBrowserViewport } from '../../../../shared/browser-devices'
import { canvasBoardKeyPath, canvasBoardName, normalizeCanvasPath } from '../../../../shared/canvas/paths'
import type {
  Workspace,
  WorkspaceId,
  WorkspacePaneState,
  WorkspacePaneTab,
  WorkspacePaneTabKind,
} from '../../types/workspace'

// The workspace pane's state (browser-pane epic): one record per workspace,
// persisted with it. Everything that decides what a tab record may contain
// lives here, so the store's writers, the persist normalizer and the
// migration that seeds the pane from a retired rail layout cannot disagree.

const WORKSPACE_PANE_TAB_KINDS: readonly WorkspacePaneTabKind[] = [
  'browser',
  'terminal',
  'files',
  'diff',
  'git',
  'backlog',
  'canvas',
]

// Kinds a workspace opens at most once: opening them again focuses the tab
// that exists. Browser and terminal tabs may open many.
//
// Canvas is in neither camp, which is why it is not listed here: a workspace
// may hold several boards at once, but only ONE tab per board. Its identity is
// the board path rather than the kind, so `canvasTabKey` below is what the
// opener and the normalizer both dedupe on.
const SINGLETON_PANE_TAB_KINDS: ReadonlySet<WorkspacePaneTabKind> = new Set([
  'files',
  'diff',
  'git',
  'backlog',
])

/**
 * What makes one Canvas tab the same tab as another: its board.
 *
 * A tab with no board is the picker, and there is only ever one of those —
 * opening Canvas again while the picker is up should land on the picker the
 * person is already looking at, not mint a second one. So "no board" is a key
 * like any other rather than an opt-out of the rule.
 */
function canvasTabKey(tab: Pick<WorkspacePaneTab, 'canvas'>): string {
  // Folded where the filesystem folds it, and main folds its own registry key
  // the same way: two spellings of one path are one file, so two tabs over them
  // would be two live editors writing the same board.
  return canvasBoardKeyPath(tab.canvas?.path ?? '', rendererPlatform())
}

/**
 * The platform, as the preload reports it. Read per call and defaulted rather
 * than captured: this module is loaded by tests that have no preload, and a
 * case-sensitive answer there is the conservative one.
 */
function rendererPlatform(): string {
  const api = typeof window === 'undefined' ? undefined : window.api
  return typeof api?.platform === 'string' ? api.platform : 'linux'
}

const MAX_PANE_TABS = 24
const MAX_TITLE_LENGTH = 200
const MAX_URL_LENGTH = 2048

// The floating player's bounds. The default is the spec's 360x240; the floor is
// small enough to park out of the way and still read a page, the ceiling keeps
// a "float" from quietly becoming a second full-size pane.
export const FLOAT_DEFAULT_WIDTH = 360
export const FLOAT_DEFAULT_HEIGHT = 240
export const FLOAT_MIN_WIDTH = 240
export const FLOAT_MIN_HEIGHT = 160
export const FLOAT_MAX_WIDTH = 1200
export const FLOAT_MAX_HEIGHT = 900
// A favicon data URL past this is not a favicon; the main process caps what it
// sends at the same size.
const MAX_FAVICON_LENGTH = 12_000

const KIND_SET = new Set<string>(WORKSPACE_PANE_TAB_KINDS)

function defaultWorkspacePaneState(): WorkspacePaneState {
  return { open: false, activeTabId: null, tabs: [] }
}

function normalizeTab(input: unknown): WorkspacePaneTab | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Partial<WorkspacePaneTab>
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return null
  if (typeof raw.kind !== 'string' || !KIND_SET.has(raw.kind)) return null
  const tab: WorkspacePaneTab = { id: raw.id, kind: raw.kind as WorkspacePaneTabKind }
  if (typeof raw.title === 'string' && raw.title.trim().length > 0) {
    tab.title = raw.title.slice(0, MAX_TITLE_LENGTH)
  }
  if (tab.kind === 'browser') {
    if (typeof raw.url === 'string' && raw.url.length > 0 && raw.url.length <= MAX_URL_LENGTH) {
      tab.url = raw.url
    }
    const viewport = normalizeBrowserViewport(raw.viewport)
    if (viewport && viewport.mode !== 'fill') tab.viewport = viewport
    const float = normalizeFloatRect(raw.float)
    if (float) tab.float = float
    if (raw.floating === true) tab.floating = true
    if (
      typeof raw.faviconUrl === 'string'
      && raw.faviconUrl.startsWith('data:image/')
      && raw.faviconUrl.length <= MAX_FAVICON_LENGTH
    ) {
      tab.faviconUrl = raw.faviconUrl
    }
  }
  if (tab.kind === 'terminal') {
    if (typeof raw.terminalId !== 'string' || raw.terminalId.trim().length === 0) return null
    tab.terminalId = raw.terminalId
  }
  if (tab.kind === 'canvas' && raw.canvas && typeof raw.canvas === 'object') {
    // An unusable path drops the FIELD, never the tab: the tab then opens on
    // the board picker, which is a surface the person can act in, where
    // dropping the tab would lose a place in the strip with no explanation.
    const path = normalizeCanvasPath(String((raw.canvas as { path?: unknown }).path ?? ''))
    if (path.ok) tab.canvas = { path: path.value }
  }
  if (tab.kind === 'diff' && raw.diff && typeof raw.diff === 'object') {
    const focusPath = typeof raw.diff.focusPath === 'string' && raw.diff.focusPath ? raw.diff.focusPath : null
    const focusKind =
      raw.diff.focusKind === 'staged' || raw.diff.focusKind === 'unstaged' ? raw.diff.focusKind : null
    const repoRoot = typeof raw.diff.repoRoot === 'string' && raw.diff.repoRoot ? raw.diff.repoRoot : undefined
    tab.diff = { ...(repoRoot ? { repoRoot } : {}), focusPath, focusKind }
  }
  return tab
}

/**
 * The one validator for a pane record. Unknown kinds, duplicate ids, a second
 * copy of a singleton kind and an active id that names no tab are all
 * repaired rather than refused — a persisted record is never a reason to
 * lose the tabs beside the bad one.
 */
export function normalizeWorkspacePaneState(input: unknown): WorkspacePaneState | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Partial<WorkspacePaneState>
  const seenIds = new Set<string>()
  const seenSingletons = new Set<WorkspacePaneTabKind>()
  const canvasBoardTabs = new Map<string, string>()
  // Where a dropped duplicate's active-ness goes: the tab that survived for the
  // same board. Falling back to the first tab in the strip would drop the
  // person somewhere they did not ask to be, on a board they did not name.
  const replacedBy = new Map<string, string>()
  const tabs: WorkspacePaneTab[] = []
  for (const candidate of Array.isArray(raw.tabs) ? raw.tabs : []) {
    const tab = normalizeTab(candidate)
    if (!tab || seenIds.has(tab.id)) continue
    if (SINGLETON_PANE_TAB_KINDS.has(tab.kind)) {
      if (seenSingletons.has(tab.kind)) continue
      seenSingletons.add(tab.kind)
    }
    if (tab.kind === 'canvas') {
      // Two tabs on one board would each hold a live editor over the same
      // file, so the second is dropped exactly as a second singleton is.
      const key = canvasTabKey(tab)
      const survivor = canvasBoardTabs.get(key)
      if (survivor !== undefined) {
        replacedBy.set(tab.id, survivor)
        continue
      }
      canvasBoardTabs.set(key, tab.id)
    }
    seenIds.add(tab.id)
    tabs.push(tab)
    if (tabs.length >= MAX_PANE_TABS) break
  }
  const asked = typeof raw.activeTabId === 'string' ? raw.activeTabId : null
  const activeTabId =
    asked !== null && seenIds.has(asked)
      ? asked
      : (asked !== null ? replacedBy.get(asked) : undefined) ?? tabs[0]?.id ?? null
  const recentUrls = normalizeRecentUrls(raw.recentUrls)
  return {
    open: raw.open === true,
    activeTabId,
    tabs,
    ...(recentUrls.length > 0 ? { recentUrls } : {}),
  }
}

/**
 * A stored float rect, or undefined.
 *
 * Sizes are clamped to the player's own bounds; the POSITION is not clamped
 * here because the window it must fit in is not known at this layer — a rect
 * saved on a wide monitor must survive being read on a laptop, and the pane
 * clamps it against the live card on render.
 */
function normalizeFloatRect(input: unknown): { x: number; y: number; width: number; height: number } | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Partial<{ x: number; y: number; width: number; height: number }>
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  if (!finite(raw.x) || !finite(raw.y) || !finite(raw.width) || !finite(raw.height)) return undefined
  return {
    x: Math.round(raw.x),
    y: Math.round(raw.y),
    width: Math.round(Math.min(Math.max(raw.width, FLOAT_MIN_WIDTH), FLOAT_MAX_WIDTH)),
    height: Math.round(Math.min(Math.max(raw.height, FLOAT_MIN_HEIGHT), FLOAT_MAX_HEIGHT)),
  }
}

function normalizeRecentUrls(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const candidate of input) {
    if (typeof candidate !== 'string' || candidate.length > MAX_URL_LENGTH) continue
    if (!/^https?:\/\//i.test(candidate) || out.includes(candidate)) continue
    out.push(candidate)
    if (out.length >= BROWSER_MAX_RECENT_URLS) break
  }
  return out
}

/** What persists: the favicon is a per-load cache and is fetched again on load. */
export function partializeWorkspacePaneState(input: unknown): WorkspacePaneState | undefined {
  const normalized = normalizeWorkspacePaneState(input)
  if (!normalized) return undefined
  return {
    ...normalized,
    tabs: normalized.tabs.map((tab) => {
      // `floating` is session-only alongside the favicon: the rect persists,
      // the "is it floating right now" does not.
      if (!tab.faviconUrl && !tab.floating) return tab
      const { faviconUrl: _faviconUrl, floating: _floating, ...rest } = tab
      return rest
    }),
  }
}

type JsonLayoutNode = { type?: string; component?: string; children?: JsonLayoutNode[] }

function layoutHasComponent(layoutModel: unknown, component: string): boolean {
  const layout = (layoutModel as { layout?: JsonLayoutNode } | null | undefined)?.layout
  const visit = (node: JsonLayoutNode | undefined): boolean => {
    if (!node) return false
    if (node.type === 'tab' && node.component === component) return true
    return (node.children ?? []).some(visit)
  }
  return visit(layout)
}

type JsonTabsetNode = JsonLayoutNode & { selected?: number }

// Whether the component's tab was the SELECTED tab of its tabset — on screen,
// not parked behind the editor in a mixed tabset (a shape `hideNavRailTabStrip`
// leaves alone on purpose). FlexLayout's default selection is the first tab.
function layoutShowsComponent(layoutModel: unknown, component: string): boolean {
  const layout = (layoutModel as { layout?: JsonLayoutNode } | null | undefined)?.layout
  const visit = (node: JsonTabsetNode | undefined): boolean => {
    if (!node) return false
    const children = node.children ?? []
    if (node.type === 'tabset') {
      const selected = typeof node.selected === 'number' && node.selected >= 0 ? node.selected : 0
      return children[selected]?.type === 'tab' && children[selected]?.component === component
    }
    return children.some(visit)
  }
  return visit(layout)
}

/**
 * The pane a retired rail layout implies (store v73): a persisted FlexLayout
 * that still had Files or Git docked left comes back with the same surfaces
 * open as pane tabs, so the migration moves the person's panels rather than
 * closing them. Undefined when the layout carried neither.
 */
export function paneStateFromLegacyLayout(layoutModel: unknown): WorkspacePaneState | undefined {
  const tabs: WorkspacePaneTab[] = []
  if (layoutHasComponent(layoutModel, 'explorer')) tabs.push({ id: nanoid(8), kind: 'files' })
  if (layoutHasComponent(layoutModel, 'git')) tabs.push({ id: nanoid(8), kind: 'git' })
  if (layoutHasComponent(layoutModel, 'backlog')) tabs.push({ id: nanoid(8), kind: 'backlog' })
  if (tabs.length === 0) return undefined
  // A lone Backlog parked behind the editor was not on screen; it comes back
  // as a tab in a pane that stays closed (the Files/Git rail was always shown).
  const open = tabs.some((tab) => tab.kind !== 'backlog') || layoutShowsComponent(layoutModel, 'backlog')
  return { open, activeTabId: tabs[0].id, tabs }
}

/**
 * The Backlog rail's move into the pane (store v74). Unlike v73 this cannot
 * ride the seed above alone: a workspace whose pane was ever used carries a
 * pane record (v73 seeded one, `paneOf` mints one on first write), and a
 * layout that still docks `backlog` has to be adopted INTO that record rather
 * than seed a second one. The rail was on screen, so a closed pane opens on
 * the backlog tab; an open pane keeps the tab it was showing and gains the
 * backlog behind it. The same record back (by reference) when there is
 * nothing to do — the layout docks no backlog, or the pane already has one.
 */
export function adoptLegacyBacklogTab(
  layoutModel: unknown,
  paneState: WorkspacePaneState,
): WorkspacePaneState {
  if (!layoutHasComponent(layoutModel, 'backlog')) return paneState
  // The heal runs on raw persisted records before any normalization: a torn
  // record without a tabs array is repaired here, never thrown on.
  const pane = Array.isArray(paneState.tabs)
    ? paneState
    : normalizeWorkspacePaneState(paneState) ?? defaultWorkspacePaneState()
  if (pane.tabs.some((tab) => tab.kind === 'backlog')) return pane
  if (pane.tabs.length >= MAX_PANE_TABS) {
    // The rail tab is still stripped by the caller; say so rather than lose
    // the surface silently. A pane at the cap is not a shape the seed path
    // (at most three tabs) can reach.
    console.warn('[workspacePane] the pane is full; the Backlog rail was not adopted as a tab')
    return pane
  }
  const tab: WorkspacePaneTab = { id: nanoid(8), kind: 'backlog' }
  // Only a Backlog that was actually on screen (the selected tab of its
  // tabset) takes the pane over: a rail tab parked behind the editor joins
  // the pane quietly, behind whatever the pane was showing.
  const railWasShowing = layoutShowsComponent(layoutModel, 'backlog')
  const paneWasShowing = pane.open && pane.activeTabId !== null
  return {
    ...pane,
    open: pane.open || railWasShowing,
    activeTabId: paneWasShowing || !railWasShowing ? pane.activeTabId ?? tab.id : tab.id,
    tabs: [...pane.tabs, tab],
  }
}

type WorkspacePaneOpenInput = {
  kind: WorkspacePaneTabKind
  title?: string
  url?: string
  terminalId?: string
  diff?: WorkspacePaneTab['diff']
  /** Canvas only: the board to open. Omitted, the tab opens on the picker. */
  canvas?: WorkspacePaneTab['canvas']
  // Whether the new (or found) tab becomes the active one and the pane opens.
  // Default true; an agent opening a background tab passes false.
  activate?: boolean
}

export interface WorkspacePaneSliceActions {
  /**
   * Open a tab and return its id. A singleton kind (Files, Git, Diff) returns
   * the existing tab, patched with the input, instead of a second copy; a
   * Canvas tab does the same per BOARD, so `canvas.open` on a board that is
   * already up focuses it rather than opening it twice. Null for an unknown
   * workspace.
   */
  openPaneTab: (id: WorkspaceId, input: WorkspacePaneOpenInput) => string | null
  closePaneTab: (id: WorkspaceId, tabId: string) => void
  setActivePaneTab: (id: WorkspaceId, tabId: string) => void
  updatePaneTab: (id: WorkspaceId, tabId: string, patch: Partial<Omit<WorkspacePaneTab, 'id' | 'kind'>>) => void
  /**
   * Point a Canvas tab at a board.
   *
   * Not `updatePaneTab`: if another tab in this pane already holds that board,
   * that tab is brought forward and THIS one closes. Two tabs over one file are
   * two live editors committing the same scene, and writing the path on anyway
   * would leave the normalizer to drop one of them after the fact — taking the
   * person somewhere they did not ask to be.
   */
  setPaneTabBoard: (id: WorkspaceId, tabId: string, path: string) => void
  setPaneOpen: (id: WorkspaceId, open: boolean) => void
  /**
   * The shortcut semantics of the old rail switches, for the singleton kinds:
   * the kind showing → close its tab (and the pane, when that empties it);
   * the kind present but behind another tab → bring it forward; absent →
   * open it. Returns whether the kind is showing afterwards.
   */
  togglePaneKind: (id: WorkspaceId, kind: WorkspacePaneTabKind) => boolean
  /** A browser tab finished loading `url`: remember it, newest first, deduped, capped. */
  notePaneRecentUrl: (id: WorkspaceId, url: string) => void
  /**
   * Float a browser tab over the workspace, or dock it back.
   *
   * One action rather than two calls because it is one gesture: floating
   * collapses the pane and docking re-opens it on that tab. Splitting it left a
   * frame where the pane was open AND the player was floating, which reads as
   * two copies of the same page.
   *
   * The guest is never re-parented — the panel keeps its place in the tree and
   * is restyled — so neither direction reloads the page.
   */
  setPaneTabFloating: (id: WorkspaceId, tabId: string, floating: boolean) => void
}

type PaneSliceCarrier = { workspaces: Workspace[] }
type PaneSliceSet = (mutator: (state: PaneSliceCarrier) => void) => void

// The record to mutate: minted on first use, otherwise the one that is there.
// Not re-normalized here — the writers below normalize what they changed — so
// a no-op write (setPaneOpen to the value it already has) keeps identity and
// wakes no subscriber.
function paneOf(ws: Workspace): WorkspacePaneState {
  if (!ws.paneState) ws.paneState = defaultWorkspacePaneState()
  return ws.paneState
}

function nextActiveAfterClose(tabs: WorkspacePaneTab[], closedIndex: number): string | null {
  // The neighbour on the right, then the left — the browser-tab convention.
  return tabs[closedIndex]?.id ?? tabs[closedIndex - 1]?.id ?? null
}

export function createWorkspacePaneSlice(set: PaneSliceSet): WorkspacePaneSliceActions {
  return {
    setPaneTabFloating: (id, tabId, floating) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const pane = paneOf(ws)
        const tab = pane.tabs.find((candidate) => candidate.id === tabId)
        if (!tab || tab.kind !== 'browser') return
        if (floating) {
          tab.floating = true
          // No rect is fabricated here: the window's size is not known at this
          // layer, and an absent rect means "the default corner", which the
          // player resolves against the live viewport.
          // Only one tab floats at a time: a second player would be a second
          // window with no way to tell them apart in the pane strip.
          for (const other of pane.tabs) if (other.id !== tabId) delete other.floating
          pane.open = false
        } else {
          delete tab.floating
          pane.open = true
          pane.activeTabId = tabId
        }
        ws.paneState = normalizeWorkspacePaneState(pane)
      }),

    openPaneTab: (id, input) => {
      let opened: string | null = null
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const pane = paneOf(ws)
        const activate = input.activate !== false
        const existing = SINGLETON_PANE_TAB_KINDS.has(input.kind)
          ? pane.tabs.find((tab) => tab.kind === input.kind)
          : input.kind === 'canvas'
            ? pane.tabs.find(
                (tab) => tab.kind === 'canvas' && canvasTabKey(tab) === canvasTabKey(input),
              )
            : undefined
        if (existing) {
          if (input.title !== undefined) existing.title = input.title
          if (input.diff !== undefined) existing.diff = input.diff
          opened = existing.id
        } else {
          if (pane.tabs.length >= MAX_PANE_TABS) return
          const tab: WorkspacePaneTab = { id: nanoid(8), kind: input.kind }
          if (input.title) tab.title = input.title
          if (input.kind === 'browser' && input.url) tab.url = input.url
          if (input.kind === 'terminal') tab.terminalId = input.terminalId ?? nanoid(10)
          if (input.kind === 'diff') tab.diff = input.diff ?? { focusPath: null, focusKind: null }
          if (input.kind === 'canvas' && input.canvas) {
            tab.canvas = input.canvas
            // The board's name IS the tab's label, so it is written where the
            // board is written. The strip falls back to the kind's label
            // ("Canvas") for a tab that has no board yet.
            tab.title ??= canvasBoardName(input.canvas.path)
          }
          pane.tabs.push(tab)
          opened = tab.id
        }
        if (activate) {
          pane.activeTabId = opened
          pane.open = true
        } else if (pane.activeTabId === null) {
          pane.activeTabId = opened
        }
        ws.paneState = normalizeWorkspacePaneState(pane)
      })
      return opened
    },

    closePaneTab: (id, tabId) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const pane = paneOf(ws)
        const index = pane.tabs.findIndex((tab) => tab.id === tabId)
        if (index === -1) return
        pane.tabs.splice(index, 1)
        if (pane.activeTabId === tabId) pane.activeTabId = nextActiveAfterClose(pane.tabs, index)
        ws.paneState = normalizeWorkspacePaneState(pane)
      }),

    setActivePaneTab: (id, tabId) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const pane = paneOf(ws)
        if (!pane.tabs.some((tab) => tab.id === tabId)) return
        pane.activeTabId = tabId
        pane.open = true
      }),

    updatePaneTab: (id, tabId, patch) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const pane = paneOf(ws)
        const tab = pane.tabs.find((candidate) => candidate.id === tabId)
        if (!tab) return
        Object.assign(tab, patch)
        // A Canvas tab that just gained (or changed) its board takes the
        // board's name with it. Derived here rather than at the call site
        // because every route to a board — the picker, an agent's open
        // request, a restored record being retargeted — must land on the same
        // label, and a caller that passed its own title still wins.
        if (tab.kind === 'canvas' && 'canvas' in patch && !('title' in patch)) {
          if (tab.canvas) tab.title = canvasBoardName(tab.canvas.path)
          else delete tab.title
        }
        ws.paneState = normalizeWorkspacePaneState(pane)
      }),

    setPaneTabBoard: (id, tabId, path) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const pane = paneOf(ws)
        const index = pane.tabs.findIndex((candidate) => candidate.id === tabId)
        const tab = pane.tabs[index]
        if (!tab || tab.kind !== 'canvas') return
        const normalized = normalizeCanvasPath(path)
        if (!normalized.ok) return
        const key = canvasTabKey({ canvas: { path: normalized.value } })
        const existing = pane.tabs.find(
          (candidate) => candidate.id !== tabId && candidate.kind === 'canvas' && canvasTabKey(candidate) === key,
        )
        if (existing) {
          pane.tabs.splice(index, 1)
          pane.activeTabId = existing.id
          pane.open = true
        } else {
          tab.canvas = { path: normalized.value }
          // The same rule `updatePaneTab` follows: the board's name is the
          // tab's label, written where the board is written.
          tab.title = canvasBoardName(normalized.value)
        }
        ws.paneState = normalizeWorkspacePaneState(pane)
      }),

    setPaneOpen: (id, open) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const pane = paneOf(ws)
        if (pane.open !== open) pane.open = open
        // Docked and floating are the same state seen from two sides, so
        // re-opening the pane docks whatever was floating. Without this the
        // floating panel is still `position: fixed` and the pane it belongs to
        // renders blank behind its own player.
        if (open) {
          for (const tab of pane.tabs) {
            if (tab.floating) {
              delete tab.floating
              pane.activeTabId = tab.id
            }
          }
        }
      }),

    notePaneRecentUrl: (id, url) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const pane = paneOf(ws)
        if (pane.recentUrls?.[0] === url) return
        const recentUrls = normalizeRecentUrls([url, ...(pane.recentUrls ?? [])])
        if (recentUrls.length === 0) return
        ws.paneState = { ...pane, recentUrls }
      }),

    togglePaneKind: (id, kind) => {
      let showing = false
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const pane = paneOf(ws)
        const index = pane.tabs.findIndex((tab) => tab.kind === kind)
        const isShowing = pane.open && index !== -1 && pane.activeTabId === pane.tabs[index].id
        if (isShowing) {
          pane.tabs.splice(index, 1)
          pane.activeTabId = nextActiveAfterClose(pane.tabs, index)
          if (pane.tabs.length === 0) pane.open = false
          ws.paneState = normalizeWorkspacePaneState(pane)
          return
        }
        if (index !== -1) {
          pane.activeTabId = pane.tabs[index].id
        } else {
          if (pane.tabs.length >= MAX_PANE_TABS) return
          const tab: WorkspacePaneTab = { id: nanoid(8), kind }
          if (kind === 'terminal') tab.terminalId = nanoid(10)
          if (kind === 'diff') tab.diff = { focusPath: null, focusKind: null }
          pane.tabs.push(tab)
          pane.activeTabId = tab.id
        }
        pane.open = true
        showing = true
        ws.paneState = normalizeWorkspacePaneState(pane)
      })
      return showing
    },
  }
}
