// The Skills surface's reads: the source list, one cached scan per source, and
// which skill directories the active workspace already holds.
//
// Sources are app-level, so the list and the scans do not depend on a
// workspace; installed state does, and reloads when the workspace changes.
// Every read reports its own outcome — a scan that failed stays an error on
// that one source rather than blanking the rail or reading as zero skills.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { InstalledPluginRecord } from '../../../../../../../shared/electron-api'
import type { ScanResult, SkillSource } from '../../../../../../../shared/skills'
import type { SkillScanLoad, SkillSourcesLoad } from './skillsSurfaceModel'

const MISSING_API_MESSAGE = 'Skills need an app restart before they are available.'

export type InstalledSkillsRead =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }
  | { status: 'ready' }

export type SkillSourcesState = {
  sources: SkillSource[]
  sourcesLoad: SkillSourcesLoad
  scans: Record<string, SkillScanLoad>
  installedDirNames: Set<string>
  installedRead: InstalledSkillsRead
  /** Plugins installed in the active workspace — receipts plus what Claude's settings enable. */
  installedPlugins: InstalledPluginRecord[]
  installedPluginsRead: InstalledSkillsRead
  /** Re-read the source list and any scan it does not already hold. */
  refreshSources: () => void
  /** Re-read one source's scan (after Sync, or to retry a failed read). */
  refreshScan: (sourceId: string) => void
  /** Re-read the workspace's installed skills (after an install). */
  refreshInstalled: () => void
  /** Take a synced source's refreshed scan, which sync already returned. */
  applySync: (source: SkillSource, scan: ScanResult) => void
}

export function useSkillSources(workspaceRoot: string | null): SkillSourcesState {
  const [sources, setSources] = useState<SkillSource[]>([])
  const [sourcesLoad, setSourcesLoad] = useState<SkillSourcesLoad>({ status: 'loading' })
  const [scans, setScans] = useState<Record<string, SkillScanLoad>>({})
  const [installedDirNames, setInstalledDirNames] = useState<Set<string>>(new Set())
  const [installedRead, setInstalledRead] = useState<InstalledSkillsRead>({ status: 'loading' })
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginRecord[]>([])
  const [installedPluginsRead, setInstalledPluginsRead] = useState<InstalledSkillsRead>({ status: 'loading' })
  const [sourcesNonce, setSourcesNonce] = useState(0)
  const [installedNonce, setInstalledNonce] = useState(0)

  // Scans already requested, so a source-list refresh does not re-fetch every
  // scan it already holds. Keyed by source id; cleared per source on refresh.
  const requestedScans = useRef<Set<string>>(new Set())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadScan = useCallback((sourceId: string) => {
    if (typeof window.api.skillsGetScan !== 'function') return
    requestedScans.current.add(sourceId)
    setScans((current) => ({ ...current, [sourceId]: { status: 'loading' } }))
    void window.api
      .skillsGetScan({ sourceId })
      .then((result) => {
        if (!mounted.current) return
        setScans((current) => ({
          ...current,
          [sourceId]: result.ok
            ? { status: 'ready', scan: result.scan }
            : { status: 'error', message: result.message },
        }))
      })
      .catch((error: unknown) => {
        if (!mounted.current) return
        setScans((current) => ({ ...current, [sourceId]: { status: 'error', message: describe(error) } }))
      })
  }, [])

  useEffect(() => {
    if (typeof window.api.skillsListSources !== 'function') {
      setSourcesLoad({ status: 'error', message: MISSING_API_MESSAGE })
      return
    }
    let cancelled = false
    void window.api
      .skillsListSources()
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setSourcesLoad({ status: 'error', message: result.message })
          return
        }
        setSources(result.sources)
        setSourcesLoad({ status: 'ready' })
        for (const source of result.sources) {
          if (!requestedScans.current.has(source.id)) loadScan(source.id)
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setSourcesLoad({ status: 'error', message: describe(error) })
      })
    return () => {
      cancelled = true
    }
  }, [loadScan, sourcesNonce])

  // The installed plugins, on the same trigger as the installed skills: both
  // are what the workspace holds, and both reload after an install.
  useEffect(() => {
    if (!workspaceRoot) {
      setInstalledPlugins([])
      setInstalledPluginsRead({ status: 'unavailable' })
      return
    }
    if (typeof window.api.skillsListInstalledPlugins !== 'function') {
      setInstalledPluginsRead({ status: 'error', message: MISSING_API_MESSAGE })
      return
    }
    let cancelled = false
    setInstalledPluginsRead({ status: 'loading' })
    void window.api
      .skillsListInstalledPlugins({ workspaceRoot })
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setInstalledPluginsRead({ status: 'error', message: result.message })
          return
        }
        setInstalledPlugins(result.plugins)
        setInstalledPluginsRead({ status: 'ready' })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setInstalledPluginsRead({ status: 'error', message: describe(error) })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot, installedNonce])

  useEffect(() => {
    if (!workspaceRoot) {
      setInstalledDirNames(new Set())
      setInstalledRead({ status: 'unavailable' })
      return
    }
    if (typeof window.api.workspaceSkillsList !== 'function') {
      setInstalledRead({ status: 'error', message: MISSING_API_MESSAGE })
      return
    }
    let cancelled = false
    setInstalledRead({ status: 'loading' })
    void window.api
      .workspaceSkillsList({ workspaceRoot })
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setInstalledRead({ status: 'error', message: result.message })
          return
        }
        setInstalledDirNames(
          new Set(result.skills.filter((skill) => skill.installState !== 'available').map((skill) => skill.id)),
        )
        setInstalledRead({ status: 'ready' })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setInstalledRead({ status: 'error', message: describe(error) })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot, installedNonce])

  const refreshSources = useCallback(() => {
    setSourcesLoad({ status: 'loading' })
    setSourcesNonce((value) => value + 1)
  }, [])

  // An update check writes the head it resolved onto each source; the list is
  // re-read so the rail's "Update available" mark is the store's, not a copy.
  // The scans it already holds are kept (requestedScans), so this never blanks
  // a canvas to arrive at bytes already in hand.
  useEffect(() => {
    if (typeof window.api.onSkillSourcesUpdated !== 'function') return
    return window.api.onSkillSourcesUpdated((check) => {
      if (!mounted.current || check.sources.length === 0) return
      if (typeof window.api.skillsListSources !== 'function') return
      void window.api
        .skillsListSources()
        .then((result) => {
          if (!mounted.current || !result.ok) return
          setSources(result.sources)
        })
        .catch(() => undefined)
    })
  }, [])

  const refreshScan = useCallback(
    (sourceId: string) => {
      loadScan(sourceId)
    },
    [loadScan],
  )

  const refreshInstalled = useCallback(() => {
    setInstalledNonce((value) => value + 1)
  }, [])

  // Sync already carries back the source and the scan it just wrote, so the
  // surface takes them directly. Re-reading the list instead would blank the
  // canvas to its loading state to arrive at bytes already in hand.
  const applySync = useCallback((synced: SkillSource, scan: ScanResult) => {
    requestedScans.current.add(synced.id)
    setSources((current) =>
      current.map((source) => (source.id === synced.id ? synced : source)),
    )
    setScans((current) => ({ ...current, [synced.id]: { status: 'ready', scan } }))
  }, [])

  return useMemo(
    () => ({
      sources,
      sourcesLoad,
      scans,
      installedDirNames,
      installedRead,
      installedPlugins,
      installedPluginsRead,
      refreshSources,
      refreshScan,
      refreshInstalled,
      applySync,
    }),
    [
      sources,
      sourcesLoad,
      scans,
      installedDirNames,
      installedRead,
      installedPlugins,
      installedPluginsRead,
      refreshSources,
      refreshScan,
      refreshInstalled,
      applySync,
    ],
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
