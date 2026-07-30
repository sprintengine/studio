import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useResolvedColorScheme } from '../../../../hooks/useAppTheme'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import type {
  DesignSystemBundleIdentity,
  DesignSystemBundleReadFailure,
} from '../../../../../../shared/design-system/bundle-view'
import type { DesignSystemManifest } from '../../../../../../shared/design-system/manifest'
import { GhostButton, PrimaryButton } from '../../../ui'
import { GlobalSurfaceShell } from '../GlobalSurfaceShell'
import { SurfaceCanvasState } from '../surfaceSubstrate'
import { useSurfaceBackNav } from '../surfaceBackNav'
import { DesignRail } from './DesignRail'
import {
  designFailureLine,
  libraryRowId,
  projectRowId,
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

/** Where the door's rail is bound in the workspace's own design-system copy. */
const ATTACHED_BUNDLE_DIRECTORY = 'design-system'

/** A bundle the rail knows about, with whatever the reader made of it. */
interface BundleRead {
  identity: DesignSystemBundleIdentity | null
  /** The parsed manifest, so the canvas can render the groups IT declares. */
  manifest: DesignSystemManifest | null
  failure: DesignSystemBundleReadFailure | null
}

/**
 * Folders pointed at during this window's session.
 *
 * Item 2004 replaces this with the persisted registry at
 * `~/.multicode/design-systems.json`; until it lands, pointing at a folder
 * genuinely opens and renders it, and says so honestly by not surviving a
 * restart rather than by pretending to save. Module-scoped, like the Sprints
 * door's rail selection: view state for the life of the window.
 */
let sessionBundlePaths: string[] = []

function joinBundlePath(root: string, child: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${child}`
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
    ? joinBundlePath(activeWorkspace.folderPath, ATTACHED_BUNDLE_DIRECTORY)
    : null

  const [libraryPaths, setLibraryPaths] = useState<string[]>(() => [...sessionBundlePaths])
  const [reads, setReads] = useState<Record<string, BundleRead>>({})
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newSelected, setNewSelected] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<DesignRailStatusFilter>('all')
  const [pointError, setPointError] = useState<string | null>(null)
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
      const paths = [...new Set([...result.entries.map((entry) => entry.path), ...sessionBundlePaths])]
      setLibraryPaths(paths)
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
    const paths = [...libraryPaths]
    if (projectBundlePath) paths.unshift(projectBundlePath)
    return [...new Set(paths)]
  }, [libraryPaths, projectBundlePath])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const path of knownPaths) {
        const result = await window.api.readDesignSystemBundle(path)
        if (cancelled || !mounted.current) return
        setReads((previous) => ({
          ...previous,
          [path]: result.ok
            ? { identity: result.view.identity, manifest: result.view.manifest, failure: null }
            : { identity: null, manifest: null, failure: result.reason },
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
    for (const path of libraryPaths) {
      if (path === projectBundlePath) continue
      const read = reads[path]
      rows.push({
        id: libraryRowId(path),
        group: 'library',
        path,
        identity: read?.identity ?? null,
        failure: read?.failure ?? null,
      })
    }
    return rows
  }, [projectBundlePath, activeWorkspace, projectHasBundle, libraryPaths, reads])

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

  const selectRow = useCallback((id: string) => {
    // Exactly one focused selection across rail and canvas.
    setNewSelected(false)
    setPointError(null)
    setSelectedId(id)
  }, [])

  // Point at a folder: the one create path that works today. Item 2005 builds
  // the full screen behind this affordance; item 2004 makes the result persist.
  const pointAtFolder = useCallback(async () => {
    setNewSelected(true)
    setSelectedId(null)
    setPointError(null)
    const picked = await window.api.openDir()
    if (!picked || !mounted.current) {
      // Cancelling leaves nothing behind — including the selection, which
      // returns to the rail rather than stranding the canvas on a create screen.
      setNewSelected(false)
      return
    }
    const result = await window.api.readDesignSystemBundle(picked)
    if (!mounted.current) return
    if (!result.ok) {
      // A folder that is not a design system is an explicit refusal naming the
      // path, never a row quietly added and then shown as broken.
      setPointError(designFailureLine(result.reason, result.path))
      return
    }
    sessionBundlePaths = [...new Set([...sessionBundlePaths, picked])]
    setReads((previous) => ({
      ...previous,
      [picked]: { identity: result.view.identity, manifest: result.view.manifest, failure: null },
    }))
    setLibraryPaths((previous) => [...new Set([...previous, picked])])
    setNewSelected(false)
    setSelectedId(libraryRowId(picked))
  }, [])

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
      onCreate={() => void pointAtFolder()}
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
      <DesignCanvas
        loadState={loadState}
        loadError={loadError}
        onRetry={() => void loadLibrary()}
        hasEntries={entries.length > 0}
        selectedEntry={selectedEntry}
        selectedManifest={selectedEntry ? (reads[selectedEntry.path]?.manifest ?? null) : null}
        pointError={pointError}
        onPointAtFolder={() => void pointAtFolder()}
      />
    </GlobalSurfaceShell>
  )
}

// The canvas: the four shared door states plus the selected system. Item 2003
// replaces the selected-system branch with the real specimen and the rendered
// components; what it shows today is the manifest's own declared contents,
// which is real data rather than a placeholder.
function DesignCanvas({
  loadState,
  loadError,
  onRetry,
  hasEntries,
  selectedEntry,
  selectedManifest,
  pointError,
  onPointAtFolder,
}: {
  loadState: 'loading' | 'ready' | 'error'
  loadError: string | null
  onRetry: () => void
  hasEntries: boolean
  selectedEntry: DesignRailEntry | null
  selectedManifest: DesignSystemManifest | null
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
    return (
      <SurfaceCanvasState
        kind="error"
        title="This design system could not be read."
        hint="It may have moved, been renamed, or lost its manifest."
        detail={designFailureLine(selectedEntry.failure, selectedEntry.path)}
        onRetry={onRetry}
        retryLabel="Read it again"
      />
    )
  }
  return <DesignSystemOverview entry={selectedEntry} manifest={selectedManifest} />
}

/**
 * What one system shows today: its folder, and the groups its own manifest
 * declares, in manifest order, each with its count.
 *
 * Groups come from `manifest.contents` rather than a taxonomy we invent — a
 * system declaring a set we did not anticipate still renders, and a group it
 * declares empty is not drawn. There is no cross-tool standard for component
 * taxonomy, so we adopt none. Item 2003 keeps this rule and adds the specimen
 * and the real rendered components beneath it.
 */
function DesignSystemOverview({
  entry,
  manifest,
}: {
  entry: DesignRailEntry
  manifest: DesignSystemManifest | null
}): JSX.Element {
  const identity = entry.identity
  const groups = manifest ? declaredGroups(manifest) : []
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The canvas toolbar: the folder this system IS, and the action that
          opens it. Both belong to the content, not to the door's top bar. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[color:var(--border-subtle)] px-6 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-micro text-[color:var(--text-subtle)]">
          {entry.path}
        </span>
        <GhostButton onClick={() => void window.api.showItemInFolder(entry.path)}>Reveal</GhostButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {identity?.summary ? (
          <p className="max-w-[68ch] text-body leading-6 text-[color:var(--text-default)]">
            {identity.summary}
          </p>
        ) : null}
        {groups.length > 0 ? (
          <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-3">
            {groups.map((group) => (
              <div key={group.key} className="flex flex-col gap-0.5">
                <dt className="text-meta text-[color:var(--text-muted)]">{group.label}</dt>
                <dd className="font-mono text-heading tabular-nums text-[color:var(--text-strong)]">
                  {group.count}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The manifest's declared contents groups, in manifest (JSON key) order.
 *
 * `contents` fixes five known keys but its type is open, so a bundle declaring
 * another group survives the canonical parser and must survive this too. Only
 * string arrays are treated as groups; an empty one is dropped.
 */
function declaredGroups(
  manifest: DesignSystemManifest,
): Array<{ key: string; label: string; count: number }> {
  return Object.entries(manifest.contents)
    .filter((pair): pair is [string, string[]] => Array.isArray(pair[1]) && pair[1].length > 0)
    .map(([key, values]) => ({ key, label: sentenceCase(key), count: values.length }))
}

/** Sentence case: `principles.md` rejects uppercase letter-spaced labels. */
function sentenceCase(key: string): string {
  const spaced = key.replace(/[-_]/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
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
