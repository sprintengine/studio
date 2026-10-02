import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'

import { installedStudioPlatform } from '../../server/platform/platform'

export type MarketplaceResourceResolver = (relativePath: string) => string | null

export type MarketplaceResourceResolutionOptions = {
  isPackaged?: boolean
  resourcesPath?: string
  appPath?: string | null
  cwd?: string
  dirname?: string
  exists?: (path: string) => boolean
}

export function findMarketplaceResourcePath(
  relativePath: string,
  options: MarketplaceResourceResolutionOptions = {},
): string | null {
  const exists = options.exists ?? existsSync
  return marketplaceResourceCandidates(relativePath, options).find((candidate) => exists(candidate)) ?? null
}

function marketplaceResourceCandidates(
  relativePath: string,
  options: MarketplaceResourceResolutionOptions = {},
): string[] {
  const safeRelativePath = normalizeMarketplaceRelativePath(relativePath)
  if (!safeRelativePath) return []

  // With no platform installed (a node test process, a script) this is a
  // source checkout with no resources root and no app root of its own.
  const paths = installedStudioPlatform()?.paths
  const isPackaged = options.isPackaged ?? paths?.isPackaged() ?? false
  const resourcesPath = options.resourcesPath ?? paths?.resourcesDir() ?? undefined
  const appPath = Object.prototype.hasOwnProperty.call(options, 'appPath')
    ? (options.appPath ?? null)
    : (paths?.appRoot() ?? null)
  const cwd = options.cwd ?? process.cwd()
  const dirname = options.dirname ?? __dirname

  if (isPackaged) {
    return [
      ...(resourcesPath ? [join(resourcesPath, 'marketplace', safeRelativePath)] : []),
      ...(appPath ? [join(appPath, 'resources', 'marketplace', safeRelativePath)] : []),
    ]
  }

  return [
    join(cwd, 'resources', 'marketplace', safeRelativePath),
    ...(appPath ? [join(appPath, 'resources', 'marketplace', safeRelativePath)] : []),
    join(dirname, '..', '..', 'resources', 'marketplace', safeRelativePath),
    join(dirname, '..', '..', '..', 'resources', 'marketplace', safeRelativePath),
  ]
}

function normalizeMarketplaceRelativePath(relativePath: string): string | null {
  if (isAbsolute(relativePath)) return null
  const normalized = normalize(relativePath).replace(/\\/g, '/')
  if (!normalized || normalized === '.' || normalized === '..') return null
  if (normalized.startsWith('../') || normalized.includes('/../')) return null
  return normalized
}
