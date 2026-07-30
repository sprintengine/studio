import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useResolvedColorScheme } from '../../../../hooks/useAppTheme'
import { pathJoin } from '../../../../utils/paths'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import type {
  DesignSystemBundleIdentity,
  DesignSystemBundleReadFailure,
} from '../../../../../../shared/design-system/bundle-view'
import type { DesignSystemBundleView } from '../../../../../../shared/design-system/bundle-view'
import { GhostButton, PrimaryButton } from '../../../ui'
import { GlobalSurfaceShell } from '../GlobalSurfaceShell'
import { SurfaceCanvasState } from '../surfaceSubstrate'
import { useSurfaceBackNav } from '../surfaceBackNav'
import type { DesignSystemLibraryEntry } from '../../../../../../shared/design-system/library'
import { DesignCanvas } from './DesignCanvas'
import { NewDesignSystemScreen, type NewDesignSystemSource } from './NewDesignSystemScreen'
import { DesignRail } from './DesignRail'
import {
  designFailureLine,
  libraryRowId,
  projectRowId,
  sourceStateFailure,
  type DesignRailEntry,
  type DesignRailStatusFilter,
} from './designRailState'

// The Design door (epic `design-door`, item 2002): design is a first-class
// surface beside Extensions, Horizon, Backlog, Sprints and Automations. The
// product model is bring, render, point at — a user builds a design system
// wherever they like, keeps it in a Git repo, and points this door at the folder
// so they can SEE it next to the agents that consume it.
//
// This item is the shell only: the nav entry, the surface, and the rail. Item
// 2003 replaces the canvas with the real specimen and rendered components, 2004
// makes the library a persisted registry of folders, and 2005 builds the create
// screen. Nothing here invents a mechanism the other six doors do not already
// have, and nothing here mounts a rail inside the canvas (MC-2014).

/** The folder's own name, used as the new system's name. */
function basenameOfPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Where the door's rail is bound in the workspace's own design-system copy. */
const ATTACHED_BUNDLE_DIRECTORY = 'design-system'

/** A bundle the rail knows about, with whatever the reader made of it. */
interface BundleRead {
  identity: DesignSystemBundleIdentity | null
  /** The whole view the canvas renders, or null when the read failed. */
  view: DesignSystemBundleView | null
  failure: DesignSystemBundleReadFailure | null
}

export default function DesignGlobalSurface(): JSX.Element {
  const back = useSurfaceBackNav()
  const scheme = useResolvedColorScheme()
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  // "In this project" is the bundle attached at <active workspace>/design-system/.
  // With no workspace open the group is simply absent — the door is global, and
  // listing every open project's attached system would contradict the heading.
  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  )
  const projectBundlePath = activeWorkspace?.folderPath
    ? pathJoin(activeWorkspace.folderPath, ATTACHED_BUNDLE_DIRECTORY)
    : null

  // The persisted registry (item 2004): every folder the user has pointed at,
  // with the source state the main process probed for it. Ids are stable across
  // sessions, so a selection survives a reload.
  const [registered, setRegistered] = useState<DesignSystemLibraryEntry[]>([])
  const [reads, setReads] = useState<Record<string, BundleRead>>({})
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newSelected, setNewSelected] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<DesignRailStatusFilter>('all')
  const [pointError, setPointError] = useState<string | null>(null)
  // Which component's variants are open, and which bundle is being re-read.
  // Both are transient view state, like every other door's selection.
  const [openComponent, setOpenComponent] = useState<string | null>(null)
  const [reloadingPath, setReloadingPath] = useState<string | null>(null)
  // The name of the source a new system is being created from, while that is in
  // flight — so the card that was clicked is the one that says "Creating…".
  const [creatingFrom, setCreatingFrom] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // The library index. Read on mount and on demand — a door that cannot list
  // the library says so with a way to retry, never an empty rail that reads as
  // "you have no design systems".
  const loadLibrary = useCallback(async () => {
    setLoadState((previous) => (previous === 'ready' ? 'ready' : 'loading'))
    setLoadError(null)
    try {
      const result = await window.api.listDesignSystemLibrary()
      if (!mounted.current) return
      setRegistered(result.entries)
      setLoadState('ready')
    } catch (error) {
      if (!mounted.current) return
      setLoadError(error instanceof Error ? error.message : String(error))
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    void loadLibrary()
  }, [loadLibrary])

  // Read every bundle the rail knows about. One IPC call per bundle, and the
  // reader is the only thing that knows the bundle layout — the renderer never
  // walks a bundle directory itself.
  const knownPaths = useMemo(() => {
    // Only folders the registry says are readable are worth a full read; a
    // broken one already carries its state from the probe, and re-reading it
    // would just repeat the same failure on every render.
    const paths = registered
      .filter((entry) => entry.sourceState === 'ok')
      .map((entry) => entry.path)
    if (projectBundlePath) paths.unshift(projectBundlePath)
    return [...new Set(paths)]
  }, [registered, projectBundlePath])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const path of knownPaths) {
        const result = await window.api.readDesignSystemBundle(path)
        if (cancelled || !mounted.current) return
        setReads((previous) => ({
          ...previous,
          [path]: result.ok
            ? { identity: result.view.identity, view: result.view, failure: null }
            : { identity: null, view: null, failure: result.reason },
        }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [knownPaths])

  // The attached bundle is only a row when the workspace actually carries one:
  // most projects have no design-system/ folder, and a permanent "not found"
  // row under "In this project" would be noise, not information.
  const projectRead = projectBundlePath ? reads[projectBundlePath] : undefined
  const projectHasBundle = Boolean(
    projectRead && !(projectRead.failure === 'missing' || projectRead.failure === 'no-manifest'),
  )

  const entries = useMemo<DesignRailEntry[]>(() => {
    const rows: DesignRailEntry[] = []
    if (projectBundlePath && activeWorkspace && projectHasBundle) {
      const read = reads[projectBundlePath]
      rows.push({
        id: projectRowId(activeWorkspace.id),
        group: 'project',
        path: projectBundlePath,
        identity: read?.identity ?? null,
        failure: read?.failure ?? null,
      })
    }
    for (const entry of registered) {
      if (entry.path === projectBundlePath) continue
      const read = reads[entry.path]
      rows.push({
        id: libraryRowId(entry.path),
        group: 'library',
        path: entry.path,
        // A registration id, so a broken row can still be re-pointed or forgotten.
        registrationId: entry.id,
        identity: read?.identity ?? null,
        // The registry's probe is authoritative for a broken folder; a live read
        // refines it for a readable one.
        failure: read?.failure ?? sourceStateFailure(entry.sourceState),
        cachedName: entry.name,
        cachedVersion: entry.version,
      })
    }
    return rows
  }, [projectBundlePath, activeWorkspace, projectHasBundle, registered, reads])

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  )

  // Keep the selection valid without stealing it: a rail whose rows changed
  // under a live selection falls back to the first row, and the New affordance
  // keeps the selection while it holds it.
  useEffect(() => {
    if (newSelected) return
    if (selectedId && entries.some((entry) => entry.id === selectedId)) return
    setSelectedId(entries[0]?.id ?? null)
  }, [entries, selectedId, newSelected])

  /**
   * Re-read one bundle from disk.
   *
   * There is no watcher and no polling in v1: the user edits in their editor and
   * comes back. A failed re-read replaces the row's state with the failure rather
   * than leaving the previous, now-wrong, render on screen.
   */
  const reloadBundle = useCallback(async (path: string) => {
    setReloadingPath(path)
    try {
      const result = await window.api.readDesignSystemBundle(path)
      if (!mounted.current) return
      setReads((previous) => ({
        ...previous,
        [path]: result.ok
          ? { identity: result.view.identity, view: result.view, failure: null }
          : { identity: null, view: null, failure: result.reason },
      }))
    } finally {
      if (mounted.current) setReloadingPath(null)
    }
  }, [])

  const selectRow = useCallback((id: string) => {
    // Exactly one focused selection across rail and canvas.
    setNewSelected(false)
    setPointError(null)
    setSelectedId(id)
    // A new system opens on its overview, never on the previous system's
    // component detail.
    setOpenComponent(null)
  }, [])

  // Point at a folder: the one create path that works today. Item 2005 builds
  // the full screen behind this affordance; item 2004 makes the result persist.
  const pointAtFolder = useCallback(async () => {
    setPointError(null)
    const picked = await window.api.openDir()
    // Cancelling leaves nothing behind — nothing on disk, nothing in the
    // registry — and leaves the create screen up rather than stranding the user.
    if (!picked || !mounted.current) return
    // Registering a REFERENCE: no copy is made anywhere, and the folder stays
    // exactly where the user's repo put it.
    const result = await window.api.registerDesignSystemFolder(picked)
    if (!mounted.current) return
    if (!result.ok) {
      // A folder that is not a design system is an explicit refusal naming the
      // path, never a row quietly added and then shown as broken.
      setPointError(result.message)
      return
    }
    const read = await window.api.readDesignSystemBundle(result.entry.path)
    if (!mounted.current) return
    if (read.ok) {
      setReads((previous) => ({
        ...previous,
        [result.entry.path]: { identity: read.view.identity, view: read.view, failure: null },
      }))
    }
    setRegistered((previous) => {
      const others = previous.filter((entry) => entry.id !== result.entry.id)
      return [...others, result.entry]
    })
    setNewSelected(false)
    setSelectedId(libraryRowId(result.entry.path))
  }, [])

  /**
   * Create a new system, seeded from one the user has (or from nothing).
   *
   * The user chooses the folder; we write the bundle there, register it, and
   * select it. Cancelling the picker leaves nothing on disk and nothing in the
   * registry — the seed is not attempted until there is a folder to write to.
   */
  const seedFrom = useCallback(async (source: NewDesignSystemSource) => {
    setPointError(null)
    const target = await window.api.openDir()
    if (!target || !mounted.current) return
    setCreatingFrom(source.name)
    try {
      const name = basenameOfPath(target)
      const seeded = await window.api.seedDesignSystemBundle(
        source.path,
        target,
        name,
        source.path ? `Seeded from ${source.name}.` : 'A new design system.',
      )
      if (!mounted.current) return
      if (!seeded.ok) {
        setPointError(seeded.message ?? 'Could not create the design system.')
        return
      }
      const bundleDir = seeded.bundleDir ?? target
      const registered = await window.api.registerDesignSystemFolder(bundleDir)
      if (!mounted.current) return
      if (!registered.ok) {
        setPointError(registered.message)
        return
      }
      await loadLibrary()
      if (!mounted.current) return
      setNewSelected(false)
      setOpenComponent(null)
      setSelectedId(libraryRowId(registered.entry.path))
    } finally {
      if (mounted.current) setCreatingFrom(null)
    }
  }, [loadLibrary])

  /**
   * Re-point a broken registration at wherever the folder went.
   *
   * Implemented as forget-then-register rather than an in-place path edit: the
   * id IS the path, so a moved folder is genuinely a different registration, and
   * pretending otherwise would leave the id lying about where it points.
   */
  const repointEntry = useCallback(async (entry: DesignRailEntry) => {
    const picked = await window.api.openDir()
    if (!picked || !mounted.current) return
    const result = await window.api.registerDesignSystemFolder(picked)
    if (!mounted.current) return
    if (!result.ok) {
      setPointError(result.message)
      return
    }
    if (entry.registrationId) await window.api.forgetDesignSystemFolder(entry.registrationId)
    if (!mounted.current) return
    await loadLibrary()
    if (!mounted.current) return
    setSelectedId(libraryRowId(result.entry.path))
  }, [loadLibrary])

  /**
   * Forget a registration: the reference goes, the user's folder does not.
   */
  const forgetEntry = useCallback(async (entry: DesignRailEntry) => {
    if (!entry.registrationId) return
    await window.api.forgetDesignSystemFolder(entry.registrationId)
    if (!mounted.current) return
    setSelectedId(null)
    await loadLibrary()
  }, [loadLibrary])

  /**
   * The create screen's cards: one per readable library system, then Empty.
   *
   * Only systems we could actually read can be a start point — seeding from a
   * folder that has moved would fail at the copy, and a card that cannot draw
   * its own specimen is not a visual start point at all.
   */
  const startSources = useMemo<NewDesignSystemSource[]>(() => {
    const cards: NewDesignSystemSource[] = []
    for (const entry of registered) {
      if (entry.sourceState !== 'ok') continue
      const view = reads[entry.path]?.view ?? null
      if (!view) continue
      cards.push({ path: entry.path, name: view.identity.name, view })
    }
    cards.push({ path: null, name: 'Empty system', view: null })
    return cards
  }, [registered, reads])

  const rail = (
    <DesignRail
      entries={entries}
      selectedId={selectedId}
      accentMode={scheme === 'light' ? 'light' : 'dark'}
      search={search}
      onSearch={setSearch}
      status={status}
      onStatus={setStatus}
      onSelect={selectRow}
      onCreate={() => {
        // The New affordance opens the create SCREEN; the folder picker is one
        // action on it, not the whole of it.
        setPointError(null)
        setSelectedId(null)
        setOpenComponent(null)
        setNewSelected(true)
      }}
      newSelected={newSelected}
    />
  )

  // The door bar is the app's ONE top bar: a name, and no more. The folder path
  // and the actions that act on it live in the canvas toolbar beside the content
  // they belong to (the shared door rule — tool clusters live with their content).
  const bar = useMemo(
    () => ({ title: selectedEntry?.identity?.name ?? 'Design' }),
    [selectedEntry],
  )

  return (
    <GlobalSurfaceShell
      ariaLabel="Design"
      bar={bar}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
      // DECLARED, not derived from what the door happens to hold: the rail is
      // present in every load state, so opening the door replaces the projects
      // sidebar immediately rather than once there is a system in it. Loading,
      // empty and error are the canvas's to say (T19 / MC-1993).
      rail={rail}
    >
      {newSelected ? (
        <NewDesignSystemScreen
          sources={startSources}
          mode={scheme === 'light' ? 'light' : 'dark'}
          busy={creatingFrom}
          error={pointError}
          onPointAtFolder={() => void pointAtFolder()}
          onSeedFrom={(source) => void seedFrom(source)}
        />
      ) : (
      <DesignSurfaceBody
        loadState={loadState}
        loadError={loadError}
        onRetry={() => void loadLibrary()}
        hasEntries={entries.length > 0}
        selectedEntry={selectedEntry}
        selectedView={selectedEntry ? (reads[selectedEntry.path]?.view ?? null) : null}
        mode={scheme === 'light' ? 'light' : 'dark'}
        openComponent={openComponent}
        onOpenComponent={setOpenComponent}
        onCloseComponent={() => setOpenComponent(null)}
        onReloadBundle={() => selectedEntry && void reloadBundle(selectedEntry.path)}
        reloadingBundle={reloadingPath !== null}
        onRepoint={() => selectedEntry && void repointEntry(selectedEntry)}
        onForget={() => selectedEntry && void forgetEntry(selectedEntry)}
        pointError={pointError}
        onPointAtFolder={() => void pointAtFolder()}
      />
      )}
    </GlobalSurfaceShell>
  )
}

// Which of the door's states the body is in: the four shared canvas states, the
// point-at-a-folder refusal, and the real canvas for a readable system. Every
// state is reachable and distinct — a folder we cannot read never renders like a
// system with no components.
function DesignSurfaceBody({
  loadState,
  loadError,
  onRetry,
  hasEntries,
  selectedEntry,
  selectedView,
  mode,
  openComponent,
  onOpenComponent,
  onCloseComponent,
  onReloadBundle,
  reloadingBundle,
  onRepoint,
  onForget,
  pointError,
  onPointAtFolder,
}: {
  loadState: 'loading' | 'ready' | 'error'
  loadError: string | null
  onRetry: () => void
  hasEntries: boolean
  selectedEntry: DesignRailEntry | null
  selectedView: DesignSystemBundleView | null
  mode: 'light' | 'dark'
  openComponent: string | null
  onOpenComponent: (name: string) => void
  onCloseComponent: () => void
  onReloadBundle: () => void
  reloadingBundle: boolean
  onRepoint: () => void
  onForget: () => void
  pointError: string | null
  onPointAtFolder: () => void
}): JSX.Element {
  if (pointError) {
    return (
      <SurfaceCanvasState
        kind="error"
        title="That folder is not a design system."
        hint="Point at the folder that holds design-system.json."
        detail={pointError}
        onRetry={onPointAtFolder}
        retryLabel="Choose another folder"
      />
    )
  }
  if (loadState === 'loading') {
    return <SurfaceCanvasState kind="loading" label="Reading your design systems…" />
  }
  if (loadState === 'error') {
    return (
      <SurfaceCanvasState
        kind="error"
        title="Couldn’t read your design system library."
        hint="This is usually temporary."
        detail={loadError ?? undefined}
        onRetry={onRetry}
      />
    )
  }
  if (!hasEntries) {
    return (
      <SurfaceCanvasState
        kind="empty"
        glyph={<DesignGlyph />}
        title="No design systems yet"
        body="A design system lives in a Git repo you clone. Point at its folder and it renders here, where the agents that consume it live."
        action={<PrimaryButton onClick={onPointAtFolder}>Point at a folder</PrimaryButton>}
      />
    )
  }
  if (!selectedEntry) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-meta text-[color:var(--text-muted)]">
        Select a design system to see it.
      </div>
    )
  }
  if (selectedEntry.failure) {
    // A broken row keeps its place in the rail and says which way it is broken,
    // with the registered path visible. The two repairs live HERE, where the row
    // is selected: point the library at wherever the folder went, or drop the
    // reference. Neither touches the user's files.
    return (
      <SurfaceCanvasState
        kind="error"
        title={brokenTitle(selectedEntry.failure)}
        hint={brokenHint(selectedEntry.failure)}
        detail={designFailureLine(selectedEntry.failure, selectedEntry.path)}
        onRetry={onRetry}
        retryLabel="Read it again"
        extraAction={
          selectedEntry.registrationId ? (
            <>
              <GhostButton onClick={onRepoint}>Re-point…</GhostButton>
              <GhostButton onClick={onForget}>Forget</GhostButton>
            </>
          ) : undefined
        }
      />
    )
  }
  if (!selectedView) {
    // Selected, readable, but its read has not landed yet. A spinner here rather
    // than an empty canvas that reads as "this system has nothing in it".
    return <SurfaceCanvasState kind="loading" label={`Reading ${selectedEntry.path}…`} />
  }
  return (
    <DesignCanvas
      view={selectedView}
      mode={mode}
      openComponent={openComponent}
      onOpenComponent={onOpenComponent}
      onCloseComponent={onCloseComponent}
      onReload={onReloadBundle}
      reloading={reloadingBundle}
    />
  )
}

/** Each broken state says what happened in the user's terms, not the reader's. */
function brokenTitle(failure: DesignSystemBundleReadFailure): string {
  switch (failure) {
    case 'missing':
      return 'That folder is no longer there.'
    case 'no-manifest':
      return 'That folder is not a design system.'
    case 'invalid-manifest':
      return 'This design system’s manifest could not be read.'
    case 'unreadable':
      return 'This folder could not be opened.'
  }
}

function brokenHint(failure: DesignSystemBundleReadFailure): string {
  switch (failure) {
    case 'missing':
      return 'It may have moved or been renamed. Point the library at its new location, or forget it.'
    case 'no-manifest':
      return 'A design system is a folder holding design-system.json.'
    case 'invalid-manifest':
      return 'The folder is there, but its design-system.json does not parse.'
    case 'unreadable':
      return 'Check the folder’s permissions, or forget it.'
  }
}

function DesignGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-icon-md" aria-hidden="true">
      <rect x="2.2" y="2.2" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M11.2 6.8h2a.8.8 0 0 1 .8.8v5.2a.8.8 0 0 1-.8.8H7.6a.8.8 0 0 1-.8-.8v-2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
