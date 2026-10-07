import { useCallback, useEffect, useState } from 'react'

import type { ProjectRepositories } from '../../../shared/project-repositories'

// The repositories a workspace folder holds when it is not one itself
// (docs/design/multi-repo-projects.md), for the Git panel's Repository row and
// the New chat composer's worktree chip. Main answers from a short cache; the
// last answer per folder is kept here too, so a panel mounted again on the
// same folder draws its row on the first frame instead of after a round trip.
// A window whose preload cannot ask, or a folder main refuses (one on an SSH
// machine), reads as a single folder: `project` null.

export type ProjectRepositoriesState = {
  /** `loading` only until the first answer for this folder; a refresh keeps the last one showing. */
  status: 'idle' | 'loading' | 'ready'
  project: ProjectRepositories | null
  /** Ask main to read the folder again. */
  refresh: () => void
}

const lastAnswers = new Map<string, ProjectRepositories | null>()

/** Forget every remembered answer. For tests. */
export function clearProjectRepositoriesAnswers(): void {
  lastAnswers.clear()
}

async function ask(folderPath: string, refresh: boolean): Promise<ProjectRepositories | null> {
  if (typeof window.api?.getProjectRepositories !== 'function') return null
  try {
    return await window.api.getProjectRepositories(folderPath, refresh ? { refresh: true } : undefined)
  } catch {
    return null
  }
}

export function useProjectRepositories(folderPath: string | null | undefined): ProjectRepositoriesState {
  const folder = folderPath?.trim() || null
  const [answer, setAnswer] = useState<{ folder: string | null; project: ProjectRepositories | null } | null>(() =>
    folder && lastAnswers.has(folder) ? { folder, project: lastAnswers.get(folder) ?? null } : null,
  )
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!folder) return
    let cancelled = false
    void ask(folder, generation > 0).then((project) => {
      lastAnswers.set(folder, project)
      if (!cancelled) setAnswer({ folder, project })
    })
    return () => {
      cancelled = true
    }
  }, [folder, generation])

  const refresh = useCallback(() => setGeneration((value) => value + 1), [])
  if (!folder) return { status: 'idle', project: null, refresh }
  // An answer for another folder is not this one's; the remembered one is.
  const current =
    answer?.folder === folder
      ? answer
      : lastAnswers.has(folder)
        ? { folder, project: lastAnswers.get(folder) ?? null }
        : null
  return current
    ? { status: 'ready', project: current.project, refresh }
    : { status: 'loading', project: null, refresh }
}
