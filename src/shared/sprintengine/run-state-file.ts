import { joinFilePath as joinPath, slugify } from '../paths'
import { knownSidecarDirName } from '../workspace-sidecar'

export type RunKind = 'sprintengine'

type RunKindConfig = {
  /** Under the workspace's sidecar directory, whichever name it goes by. */
  rootSegments: string[]
  slugFallback: string
  stateFileName: string
}

const RUN_KIND_CONFIG: Record<RunKind, RunKindConfig> = {
  sprintengine: {
    rootSegments: ['sprintengine'],
    slugFallback: 'sprintengine-team',
    stateFileName: 'run.yaml',
  },
}

export function slugifyRunName(kind: RunKind, name: string | null | undefined): string {
  return slugify(name) || RUN_KIND_CONFIG[kind].slugFallback
}

export function getRunRootDirectoryPath(folderPath: string, kind: RunKind): string {
  return RUN_KIND_CONFIG[kind].rootSegments.reduce(
    (accumulator, segment) => joinPath(accumulator, segment),
    joinPath(folderPath, knownSidecarDirName(folderPath))
  )
}

export function getRunDirectoryPath(folderPath: string, kind: RunKind, runName?: string): string {
  return joinPath(getRunRootDirectoryPath(folderPath, kind), slugifyRunName(kind, runName))
}


export function getRunStateFilePath(folderPath: string, kind: RunKind, runName?: string): string {
  return joinPath(getRunDirectoryPath(folderPath, kind, runName), RUN_KIND_CONFIG[kind].stateFileName)
}
