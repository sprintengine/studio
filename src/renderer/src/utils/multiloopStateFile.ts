import type { MultiloopStateReadResult } from '../types/workspace'
import { parseMultiloopStateFileContent } from './multiloop'

function joinPath(basePath: string, child: string): string {
  const sep = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/'
  return `${basePath.replace(/[\\/]+$/, '')}${sep}${child}`
}

export function slugifyMultiloopName(name: string | null | undefined): string {
  const slug = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'multiloop'
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
