import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type TrustedPublishersFile = {
  schemaVersion?: number
  publishers?: Array<{ fingerprint?: unknown }>
}

function loadElectron(): typeof import('electron') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron') as typeof import('electron')
  } catch {
    return null
  }
}

export function readTrustedMarketplacePublisherFingerprintsSync(): Set<string> {
  const path = findTrustedPublishersPath()
  if (!path) return new Set()
  try {
    const payload = JSON.parse(readFileSync(path, 'utf8')) as TrustedPublishersFile
    return new Set(
      (payload.publishers ?? [])
        .map((publisher) => publisher.fingerprint)
        .filter((fingerprint): fingerprint is string => typeof fingerprint === 'string' && fingerprint.trim().length > 0)
        .map((fingerprint) => fingerprint.trim())
    )
  } catch {
    return new Set()
  }
}

function findTrustedPublishersPath(): string | null {
  const electron = loadElectron()
  const candidates = electron?.app?.isPackaged
    ? [
        join(process.resourcesPath, 'marketplace', 'trusted-publishers.json'),
        join(electron.app.getAppPath(), 'resources', 'marketplace', 'trusted-publishers.json'),
      ]
    : [
        join(process.cwd(), 'resources', 'marketplace', 'trusted-publishers.json'),
        ...(electron?.app?.getAppPath ? [join(electron.app.getAppPath(), 'resources', 'marketplace', 'trusted-publishers.json')] : []),
        join(__dirname, '..', '..', 'resources', 'marketplace', 'trusted-publishers.json'),
        join(__dirname, '..', '..', '..', 'resources', 'marketplace', 'trusted-publishers.json'),
      ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}
