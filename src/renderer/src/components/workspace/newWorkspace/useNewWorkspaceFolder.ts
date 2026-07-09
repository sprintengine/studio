import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getExistingSprintEngineStateFilePath,
  getSprintEngineStateFilePath,
  getSprintEngineDirectoryPath,
  slugifySprintEngineName,
} from '../../../utils/sprintengineStateFile'
import { normalizeSprintEngineProjection } from '../../../utils/sprintengine'
import type {
  SprintEngineState,
  SprintEngineWorkspaceContext,
} from '../../../types/workspace'
import {
  basename,
  joinPath,
  shouldScanDirectory,
  toTitleName,
  workspaceRelativePath,
} from './helpers'
import type { ExistingTeam, FolderScanResult, MarkdownPlanOption, UnreadableTeam } from './types'

const MAX_PLAN_FILES = 500

function getExistingTeamDisplayName(slug: string, state: SprintEngineState): string {
  const stateName = state.name.trim()
  return slugifySprintEngineName(stateName) === slug.toLowerCase()
    ? stateName
    : toTitleName(slug)
}

export function buildSprintEngineContext(
  folderPath: string,
  teamName: string,
  teamSlug: string,
): SprintEngineWorkspaceContext {
  return {
    teamName,
    teamSlug,
    teamDirectoryPath: getSprintEngineDirectoryPath(folderPath, teamSlug),
    statePath: getSprintEngineStateFilePath(folderPath, teamSlug),
  }
}

async function scanExistingTeams(
  folderPath: string,
): Promise<{ teams: ExistingTeam[]; unreadableTeams: UnreadableTeam[] }> {
  const entries = await window.api
    .readdir(joinPath(joinPath(folderPath, '.multi-code'), 'sprintengine'))
    .catch(() => [])
  const teams: ExistingTeam[] = []
  const unreadableTeams: UnreadableTeam[] = []
  for (const entry of entries) {
    if (!entry.isDir) continue
    try {
      const projection = await window.api.readSprintEngineProjection(
        getExistingSprintEngineStateFilePath(folderPath, entry.name),
      )
      // A folder with no readable projection is usually not a Sprint Engine state
      // directory at all, so only a store the main process explicitly rejected
      // (message present) is surfaced — silently dropping THAT would look like a
      // vanished sprint. See describeUnsupportedSprintEngineStore.
      if (!projection.ok) {
        if (projection.message) unreadableTeams.push({ slug: entry.name, message: projection.message })
        continue
      }
      const state = normalizeSprintEngineProjection(projection.data, entry.name)
      if (!state) {
        unreadableTeams.push({ slug: entry.name, message: 'Sprint projection was malformed.' })
        continue
      }
      const displayName = getExistingTeamDisplayName(entry.name, state)
      teams.push({
        slug: entry.name,
        displayName,
        context: buildSprintEngineContext(folderPath, displayName, entry.name),
        state,
      })
    } catch {
      // Ignore folders that are not Sprint Engine state directories.
    }
  }
  return { teams, unreadableTeams }
}

export async function scanSourceFiles(folderPath: string): Promise<MarkdownPlanOption[]> {
  const options: MarkdownPlanOption[] = []
  const backlogPath = joinPath(folderPath, 'backlog')
  const queue = [backlogPath]

  while (queue.length > 0 && options.length < MAX_PLAN_FILES) {
    const dir = queue.shift()
    if (!dir) break

    const entries = await window.api.readdir(dir).catch(() => [])
    for (const entry of entries) {
      const entryPath = joinPath(dir, entry.name)
      if (entry.isDir) {
        if (shouldScanDirectory(entry.name)) queue.push(entryPath)
        continue
      }

      if (!/\.(md|html?)$/i.test(entry.name)) continue
      const relativePath = workspaceRelativePath(folderPath, entryPath)
      if (relativePath?.replace(/\\/g, '/').startsWith('backlog/')) {
        options.push({ path: entryPath, relativePath })
      }
      if (options.length >= MAX_PLAN_FILES) break
    }
  }

  return options.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

export async function scanFolder(folderPath: string): Promise<FolderScanResult> {
  const [existing, plans] = await Promise.all([
    scanExistingTeams(folderPath),
    scanSourceFiles(folderPath),
  ])
  return { teams: existing.teams, unreadableTeams: existing.unreadableTeams, plans }
}

/**
 * Lightweight detection used to render chips on recent-folder rows. Only
 * checks whether the SprintEngine state directory has any team folders;
 * deeper plan scans happen only after the folder is selected.
 */
export async function detectFolderHints(folderPath: string): Promise<{
  hasSprintEngineTeam: boolean
  hasMultiloop: boolean
}> {
  const [seEntries, multiEntries] = await Promise.all([
    window.api
      .readdir(joinPath(joinPath(folderPath, '.multi-code'), 'sprintengine'))
      .catch(() => []),
    window.api
      .readdir(joinPath(joinPath(folderPath, '.multi-code'), 'multiloop'))
      .catch(() => []),
  ])
  return {
    hasSprintEngineTeam: seEntries.some((entry) => entry.isDir),
    hasMultiloop: multiEntries.some((entry) => entry.isDir),
  }
}

export type FolderHintsCache = Map<string, { hasSprintEngineTeam: boolean; hasMultiloop: boolean }>

export function useFolderHints(folderPaths: string[]): FolderHintsCache {
  const [cache, setCache] = useState<FolderHintsCache>(new Map())

  useEffect(() => {
    let cancelled = false
    const todo = folderPaths.filter((path) => !cache.has(path))
    if (todo.length === 0) return
    void Promise.all(
      todo.map(async (path) => {
        const hints = await detectFolderHints(path).catch(() => ({
          hasSprintEngineTeam: false,
          hasMultiloop: false,
        }))
        return [path, hints] as const
      }),
    ).then((entries) => {
      if (cancelled) return
      setCache((prev) => {
        const next = new Map(prev)
        for (const [path, hints] of entries) next.set(path, hints)
        return next
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderPaths.join('|')])

  return cache
}

export function useFolderScan(folderPath: string | null): {
  isScanning: boolean
  result: FolderScanResult
  rescan: () => Promise<void>
} {
  const [result, setResult] = useState<FolderScanResult>({ teams: [], unreadableTeams: [], plans: [] })
  const [isScanning, setIsScanning] = useState(false)

  const rescan = useCallback(async () => {
    if (!folderPath) {
      setResult({ teams: [], unreadableTeams: [], plans: [] })
      return
    }
    setIsScanning(true)
    try {
      const next = await scanFolder(folderPath)
      setResult(next)
    } finally {
      setIsScanning(false)
    }
  }, [folderPath])

  useEffect(() => {
    void rescan()
  }, [rescan])

  return useMemo(() => ({ isScanning, result, rescan }), [isScanning, result, rescan])
}

export { basename }
