import { nanoid } from 'nanoid'
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

export const WORKSPACE_PANE_TAB_KINDS: readonly WorkspacePaneTabKind[] = [
  'browser',
  'terminal',
  'files',
  'diff',
  'git',
]

// Kinds a workspace opens at most once: opening them again focuses the tab
// that exists. Browser and terminal tabs may open many.
export const SINGLETON_PANE_TAB_KINDS: ReadonlySet<WorkspacePaneTabKind> = new Set([
  'files',
  'diff',
  'git',
])

const MAX_PANE_TABS = 24
const MAX_TITLE_LENGTH = 200
const MAX_URL_LENGTH = 2048
// A favicon data URL past this is not a favicon; the main process caps what it
// sends at the same size.
const MAX_FAVICON_LENGTH = 12_000

const KIND_SET = new Set<string>(WORKSPACE_PANE_TAB_KINDS)

export function defaultWorkspacePaneState(): WorkspacePaneState {
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
    tab.diff = { focusPath, focusKind }
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
  return { open: raw.open === true, activeTabId, tabs }
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
  if (tabs.length === 0) return undefined
  return { open: true, activeTabId: tabs[0].id, tabs }
}

export type WorkspacePaneOpenInput = {
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
}

type PaneSliceCarrier = { workspaces: Workspace[] }
type PaneSliceSet = (mutator: (state: PaneSliceCarrier) => void) => void

function paneOf(ws: Workspace): WorkspacePaneState {
  const current = normalizeWorkspacePaneState(ws.paneState) ?? defaultWorkspacePaneState()
  ws.paneState = current
  return current
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
        paneOf(ws).open = open
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
