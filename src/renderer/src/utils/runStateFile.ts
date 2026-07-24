import { joinFilePath as joinPath, slugify } from './paths'

export type RunKind = 'sprintengine'

type RunKindConfig = {
  rootSegments: string[]
  slugFallback: string
  stateFileName: string
}

const RUN_KIND_CONFIG: Record<RunKind, RunKindConfig> = {
  sprintengine: {
    rootSegments: ['.multi-code', 'sprintengine'],
    slugFallback: 'sprintengine-team',
    stateFileName: 'run.yaml',
  },
}

export function slugifyRunName(kind: RunKind, name: string | null | undefined): string {
  return slugify(name) || RUN_KIND_CONFIG[kind].slugFallback
}

export function getRunStateFileName(kind: RunKind): string {
  return RUN_KIND_CONFIG[kind].stateFileName
}

export function getRunRootDirectoryPath(folderPath: string, kind: RunKind): string {
  return RUN_KIND_CONFIG[kind].rootSegments.reduce(
    (accumulator, segment) => joinPath(accumulator, segment),
    folderPath
  )
}

export function getRunDirectoryPath(folderPath: string, kind: RunKind, runName?: string): string {
  return joinPath(getRunRootDirectoryPath(folderPath, kind), slugifyRunName(kind, runName))
}

export function getExistingRunStateFilePath(
  folderPath: string,
  kind: RunKind,
  runDirectoryName: string
): string {
  return joinPath(
    joinPath(getRunRootDirectoryPath(folderPath, kind), runDirectoryName),
    RUN_KIND_CONFIG[kind].stateFileName
  )
}

export function getRunStateFilePath(folderPath: string, kind: RunKind, runName?: string): string {
  return joinPath(getRunDirectoryPath(folderPath, kind, runName), RUN_KIND_CONFIG[kind].stateFileName)
}
