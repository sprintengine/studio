import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getExistingSprintEngineStateFilePath,
  getSprintEngineStateFilePath,
  getSprintEngineDirectoryPath,
  parseSprintEngineStateFile,
  slugifySprintEngineName,
} from '../../../utils/sprintengineStateFile'
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
import type { ExistingTeam, FolderScanResult, MarkdownPlanOption } from './types'

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

async function scanExistingTeams(folderPath: string): Promise<ExistingTeam[]> {
  const entries = await window.api
    .readdir(joinPath(joinPath(folderPath, '.multi-code'), 'sprintengine'))
    .catch(() => [])
  const teams: ExistingTeam[] = []
  for (const entry of entries) {
    if (!entry.isDir) continue
    try {
      const content = await window.api.readfile(
        getExistingSprintEngineStateFilePath(folderPath, entry.name),
      )
      const state = parseSprintEngineStateFile(content, entry.name)
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
  return teams
}

async function scanMarkdownPlans(folderPath: string): Promise<MarkdownPlanOption[]> {
  const options: MarkdownPlanOption[] = []
  const queue = [folderPath]

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

      if (!/\.md$/i.test(entry.name)) continue
      const relativePath = workspaceRelativePath(folderPath, entryPath)
      if (relativePath) options.push({ path: entryPath, relativePath })
      if (options.length >= MAX_PLAN_FILES) break
    }
  }

  return options.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

export async function scanFolder(folderPath: string): Promise<FolderScanResult> {
  const [teams, plans] = await Promise.all([
    scanExistingTeams(folderPath),
    scanMarkdownPlans(folderPath),
  ])
  return { teams, plans }
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
  const [result, setResult] = useState<FolderScanResult>({ teams: [], plans: [] })
  const [isScanning, setIsScanning] = useState(false)

  const rescan = useCallback(async () => {
    if (!folderPath) {
      setResult({ teams: [], plans: [] })
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
