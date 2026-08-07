import { joinFilePath as joinPath } from '../paths'
import {
  getExistingRunStateFilePath,
  getRunDirectoryPath,
  getRunRootDirectoryPath,
  getRunStateFilePath,
  slugifyRunName,
} from './run-state-file'

export function slugifySprintEngineName(name: string | null | undefined): string {
  return slugifyRunName('sprintengine', name)
}

export function getSprintEngineRootDirectoryPath(folderPath: string): string {
  return getRunRootDirectoryPath(folderPath, 'sprintengine')
}

export function getSprintEngineDirectoryPath(folderPath: string, sprintEngineName?: string): string {
  return getRunDirectoryPath(folderPath, 'sprintengine', sprintEngineName)
}

export function getExistingSprintEngineStateFilePath(folderPath: string, sprintEngineDirectoryName: string): string {
  return getExistingRunStateFilePath(folderPath, 'sprintengine', sprintEngineDirectoryName)
}

export function getSprintEngineStateFilePath(folderPath: string, sprintEngineName?: string): string {
  return getRunStateFilePath(folderPath, 'sprintengine', sprintEngineName)
}

export function getSprintEnginePlanFilePath(folderPath: string, sprintEngineName?: string): string {
  return joinPath(getSprintEngineDirectoryPath(folderPath, sprintEngineName), 'plan.md')
}
