import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'

type ElectronAppLike = {
  isPackaged?: boolean
  getAppPath?: () => string
}

type ElectronLike = {
  app?: ElectronAppLike
}

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

  const electron = loadElectron()
  const app = electron?.app
  const isPackaged = options.isPackaged ?? app?.isPackaged ?? false
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  const appPath = Object.prototype.hasOwnProperty.call(options, 'appPath')
    ? (options.appPath ?? null)
    : (app?.getAppPath?.() ?? null)
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

function loadElectron(): ElectronLike | null {
  try {
    return require('electron') as ElectronLike
  } catch {
    return null
  }
}
