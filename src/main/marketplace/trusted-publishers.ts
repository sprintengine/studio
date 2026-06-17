import { readFileSync } from 'node:fs'

import { findMarketplaceResourcePath } from './resources'

type TrustedPublishersFile = {
  schemaVersion?: number
  publishers?: Array<{ fingerprint?: unknown }>
}

export function readTrustedMarketplacePublisherFingerprintsSync(): Set<string> {
  const path = findMarketplaceResourcePath('trusted-publishers.json')
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
