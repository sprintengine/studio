import { nanoid } from 'nanoid'
import { BROWSER_MAX_RECENT_URLS } from '../../../../shared/browser'
import { normalizeBrowserViewport } from '../../../../shared/browser-devices'
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
]

// Kinds a workspace opens at most once: opening them again focuses the tab
// that exists. Browser and terminal tabs may open many.
const SINGLETON_PANE_TAB_KINDS: ReadonlySet<WorkspacePaneTabKind> = new Set([
  'files',
  'diff',
  'git',
  'backlog',
])

const MAX_PANE_TABS = 24
const MAX_TITLE_LENGTH = 200
const MAX_URL_LENGTH = 2048
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
  const tabs: WorkspacePaneTab[] = []
  for (const candidate of Array.isArray(raw.tabs) ? raw.tabs : []) {
    const tab = normalizeTab(candidate)
    if (!tab || seenIds.has(tab.id)) continue
    if (SINGLETON_PANE_TAB_KINDS.has(tab.kind)) {
      if (seenSingletons.has(tab.kind)) continue
      seenSingletons.add(tab.kind)
    }
    seenIds.add(tab.id)
    tabs.push(tab)
    if (tabs.length >= MAX_PANE_TABS) break
  }
  const activeTabId =
    typeof raw.activeTabId === 'string' && seenIds.has(raw.activeTabId)
      ? raw.activeTabId
      : tabs[0]?.id ?? null
  const recentUrls = normalizeRecentUrls(raw.recentUrls)
  return {
    open: raw.open === true,
    activeTabId,
    tabs,
    ...(recentUrls.length > 0 ? { recentUrls } : {}),
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
      if (!tab.faviconUrl) return tab
      const { faviconUrl: _faviconUrl, ...rest } = tab
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
  // Whether the new (or found) tab becomes the active one and the pane opens.
  // Default true; an agent opening a background tab passes false.
  activate?: boolean
}

export interface WorkspacePaneSliceActions {
  /**
   * Open a tab and return its id. A singleton kind (Files, Git, Diff) returns
   * the existing tab, patched with the input, instead of a second copy. Null
   * for an unknown workspace.
   */
  openPaneTab: (id: WorkspaceId, input: WorkspacePaneOpenInput) => string | null
  closePaneTab: (id: WorkspaceId, tabId: string) => void
  setActivePaneTab: (id: WorkspaceId, tabId: string) => void
  updatePaneTab: (id: WorkspaceId, tabId: string, patch: Partial<Omit<WorkspacePaneTab, 'id' | 'kind'>>) => void
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
    openPaneTab: (id, input) => {
      let opened: string | null = null
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const pane = paneOf(ws)
        const activate = input.activate !== false
        const existing = SINGLETON_PANE_TAB_KINDS.has(input.kind)
          ? pane.tabs.find((tab) => tab.kind === input.kind)
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
        ws.paneState = normalizeWorkspacePaneState(pane)
      }),

    setPaneOpen: (id, open) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (!ws) return
        const pane = paneOf(ws)
        if (pane.open !== open) pane.open = open
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
