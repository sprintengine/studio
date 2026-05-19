import type { MultiloopStateReadResult } from '../types/workspace'
import { parseMultiloopStateFileContent } from './multiloop'
import {
  getExistingRunStateFilePath,
  getRunDirectoryPath,
  getRunRootDirectoryPath,
  getRunStateFilePath,
  slugifyRunName,
} from './runStateFile'

export function slugifyMultiloopName(name: string | null | undefined): string {
  return slugifyRunName('multiloop', name)
}

export function getMultiloopRootDirectoryPath(folderPath: string): string {
  return getRunRootDirectoryPath(folderPath, 'multiloop')
}

export function getMultiloopDirectoryPath(folderPath: string, loopName?: string): string {
  return getRunDirectoryPath(folderPath, 'multiloop', loopName)
}

export function getExistingMultiloopStateFilePath(folderPath: string, loopDirectoryName: string): string {
  return getExistingRunStateFilePath(folderPath, 'multiloop', loopDirectoryName)
}

export function getMultiloopStateFilePath(folderPath: string, loopName?: string): string {
  return getRunStateFilePath(folderPath, 'multiloop', loopName)
}

export function parseMultiloopStateFile(content: string): MultiloopStateReadResult {
  return parseMultiloopStateFileContent(content)
}
