import { joinFilePath as joinPath, slugify } from './paths'

export function slugifySprintEngineName(name: string | null | undefined): string {
  return slugify(name) || 'sprintengine-team'
}

export function getSprintEngineRootDirectoryPath(folderPath: string): string {
  return joinPath(joinPath(folderPath, '.multi-code'), 'sprintengine')
}

export function getSprintEngineDirectoryPath(folderPath: string, sprintEngineName?: string): string {
  return joinPath(getSprintEngineRootDirectoryPath(folderPath), slugifySprintEngineName(sprintEngineName))
}

export function getExistingSprintEngineStateFilePath(folderPath: string, sprintEngineDirectoryName: string): string {
  return joinPath(joinPath(getSprintEngineRootDirectoryPath(folderPath), sprintEngineDirectoryName), 'run.yaml')
}

export function getSprintEngineStateFilePath(folderPath: string, sprintEngineName?: string): string {
  return joinPath(getSprintEngineDirectoryPath(folderPath, sprintEngineName), 'run.yaml')
}

export function getSprintEnginePlanFilePath(folderPath: string, sprintEngineName?: string): string {
  return joinPath(getSprintEngineDirectoryPath(folderPath, sprintEngineName), 'plan.md')
}
