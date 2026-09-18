import { readFileSync } from 'node:fs'

import { findMarketplaceResourcePath, type MarketplaceResourceResolver } from './resources'

type TrustedPublishersFile = {
  schemaVersion?: number
  publishers?: Array<{ fingerprint?: unknown }>
}

/**
 * The gitignored, source-build-only companion to `trusted-publishers.json`
 * (D2). A first-party module is publisher-locked to the release signing key, so
 * a contributor building the app from source could not install their own build
 * of one — they do not have that key. Dropping their own dev public key in this
 * file makes their own signature trusted on their own machine.
 *
 * It is unioned ONLY when the app is not packaged. A shipped build resolves its
 * marketplace resources out of the asar/resources directory, and the file is
 * never packaged, but the `isPackaged` gate is what states the rule rather than
 * leaving it to what happens to be on disk.
 */
export const TRUSTED_PUBLISHERS_DEV_FILENAME = 'trusted-publishers.dev.json'

export type TrustedPublisherReadOptions = {
  /**
   * Whether this is a packaged build. Injected so the read works in a plain
   * node test process, where `require('electron')` resolves to nothing — the
   * default asks electron and falls back to "not packaged", which is what a
   * source checkout is.
   */
  isPackaged?: boolean
  /** Test seam for locating the two files; defaults to the packaged/source resolver. */
  resolveResourcePath?: MarketplaceResourceResolver
}

function readFingerprintsFile(path: string | null): string[] {
  if (!path) return []
  try {
    const payload = JSON.parse(readFileSync(path, 'utf8')) as TrustedPublishersFile
    return (payload.publishers ?? [])
      .map((publisher) => publisher.fingerprint)
      .filter((fingerprint): fingerprint is string => typeof fingerprint === 'string' && fingerprint.trim().length > 0)
      .map((fingerprint) => fingerprint.trim())
  } catch {
    return []
  }
}

function resolveIsPackaged(options: TrustedPublisherReadOptions): boolean {
  if (typeof options.isPackaged === 'boolean') return options.isPackaged
  try {
    const electron = require('electron') as { app?: { isPackaged?: boolean } }
    return electron?.app?.isPackaged === true
  } catch {
    // No electron (a node test process, a script): a source checkout.
    return false
  }
}

export function readTrustedMarketplacePublisherFingerprintsSync(
  options: TrustedPublisherReadOptions = {},
): Set<string> {
  const resolve = options.resolveResourcePath ?? ((relative: string) => findMarketplaceResourcePath(relative))
  const fingerprints = new Set(readFingerprintsFile(resolve('trusted-publishers.json')))
  if (resolveIsPackaged(options)) return fingerprints
  for (const fingerprint of readFingerprintsFile(resolve(TRUSTED_PUBLISHERS_DEV_FILENAME))) {
    fingerprints.add(fingerprint)
  }
  return fingerprints
}
