import type { MultiloopStateReadResult } from '../types/workspace'
import { parseMultiloopStateFileContent } from './multiloop'
import { joinFilePath as joinPath, slugify } from './paths'

export function slugifyMultiloopName(name: string | null | undefined): string {
  return slugify(name) || 'multiloop'
}

export function getMultiloopRootDirectoryPath(folderPath: string): string {
  return joinPath(folderPath, 'multiloop')
}

export function getMultiloopDirectoryPath(folderPath: string, loopName?: string): string {
  return joinPath(getMultiloopRootDirectoryPath(folderPath), slugifyMultiloopName(loopName))
}

export function getExistingMultiloopStateFilePath(folderPath: string, loopDirectoryName: string): string {
  return joinPath(joinPath(getMultiloopRootDirectoryPath(folderPath), loopDirectoryName), 'state.json')
}

export function getMultiloopStateFilePath(folderPath: string, loopName?: string): string {
  return joinPath(getMultiloopDirectoryPath(folderPath, loopName), 'state.json')
}

export function parseMultiloopStateFile(content: string): MultiloopStateReadResult {
  return parseMultiloopStateFileContent(content)
}
