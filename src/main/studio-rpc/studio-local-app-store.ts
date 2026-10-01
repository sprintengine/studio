import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  STUDIO_SCOPES,
  normalizeStudioScopes,
  type StudioGrant,
  type StudioScope,
} from '../../../packages/studio-protocol/src/public'
import { parseCliPermissionPreset, type CliPermissionPreset } from '../../shared/cli-permission-preset'
import type { StudioLocalApp, StudioLocalAppOffer, StudioLocalAppOfferInput } from '../../shared/studio-local-apps'
import { hashSecret, secretsMatch } from '../automation/tailnet/secret-hash'

// The applications paired with Studio's owner socket, and how each proves it.
//
// The model is the tailnet device store's offer path, for apps on this
// machine instead of devices on the tailnet. The person mints a one-time
// pairing code in Settings, naming the app, the scopes it gets and its
// permission ceiling; the app's first hello presents the code, and its welcome
// carries a long-lived token exactly once. Only the token's SHA-256 reaches
// disk (0600), so a copied store file cannot be presented back. An outstanding
// code never reaches disk at all: it lives in this process, so a restart
// voids every unredeemed code rather than leaving one live nobody remembers.
//
// The app's grant is fixed at pairing and read live on every request, so a
// revoke lands on the next frame of every connection the app has open. To
// change what an app may do, revoke it and pair it again: a grant only an app's
// own pairing created is a grant nobody widened behind its back.
//
// The owner token is the desktop's own credential for the day its windows
// talk to the RPC. It is minted fresh in memory for each run and handed to
// nothing outside this process, so no file on disk grants owner access.

export const STUDIO_LOCAL_APPS_FILENAME = 'studio-local-apps.json'
/** How long a pairing code waits to be used. Long enough to paste it into a script, short enough to forget safely. */
const OFFER_TTL_MS = 10 * 60 * 1000
const MAX_OFFERS = 8
const MAX_APPS = 64
/** How often an app's last-seen reaches disk. In memory it is always current. */
const LAST_SEEN_PERSIST_INTERVAL_MS = 60 * 1000
const OWNER_CLIENT_ID = 'owner'

type StoredApp = Omit<StudioLocalApp, 'connected'> & { tokenHash: string }
type Offer = StudioLocalAppOffer & { codeHash: string; expiresAtMs: number }

export type StudioLocalAppRedeemResult =
  { ok: true; grant: StudioGrant; token: string } | { ok: false; message: string }

export type StudioLocalAppStore = {
  list(): Omit<StudioLocalApp, 'connected'>[]
  offers(): StudioLocalAppOffer[]
  /** Mint a one-time pairing code. Throws on input Settings should never send. */
  offer(input: unknown): { offer: StudioLocalAppOffer; code: string }
  cancelOffer(id: string): boolean
  /** Exchange a pairing code for the app it names and a token, once. */
  redeem(code: string): StudioLocalAppRedeemResult
  /** The grant a token proves, or null. Reads live state, so a revoke lands on the next call. */
  authenticate(token: string): StudioGrant | null
  grantFor(clientId: string): StudioGrant | null
  revoke(id: string): boolean
  recordSeen(id: string): void
  /** This run's owner token. */
  ownerToken(): string
  onRevoked(listener: (id: string) => void): () => void
  onChanged(listener: () => void): () => void
}

function ownerGrant(): StudioGrant {
  return {
    clientId: OWNER_CLIENT_ID,
    name: 'SprintEngine Studio',
    owner: true,
    scopes: [...STUDIO_SCOPES],
    ceiling: 'bypass',
  }
}

function grantOf(app: StoredApp): StudioGrant {
  return { clientId: app.id, name: app.name, owner: false, scopes: [...app.scopes], ceiling: app.ceiling }
}

function publicApp(app: StoredApp): Omit<StudioLocalApp, 'connected'> {
  return {
    id: app.id,
    name: app.name,
    scopes: [...app.scopes],
    ceiling: app.ceiling,
    createdAt: app.createdAt,
    lastSeenAt: app.lastSeenAt,
  }
}

function publicOffer(offer: Offer): StudioLocalAppOffer {
  return {
    id: offer.id,
    name: offer.name,
    scopes: [...offer.scopes],
    ceiling: offer.ceiling,
    expiresAt: offer.expiresAt,
  }
}

/** Settings' request to pair an app, checked: a name, at least one scope, a preset. */
export function parseStudioLocalAppOfferInput(value: unknown): StudioLocalAppOfferInput {
  const input = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : ''
  if (!name) throw new Error('Name the app, so it can be told apart in Settings and in the audit.')
  const scopes: StudioScope[] = normalizeStudioScopes(input.scopes)
  if (!scopes.length) throw new Error('Give the app at least one thing it may do.')
  const ceiling: CliPermissionPreset | null = parseCliPermissionPreset(input.ceiling)
  if (!ceiling) throw new Error('Choose the loosest permission preset its chats may run on.')
  return { name, scopes, ceiling }
}

function readApps(path: string, log?: (message: string) => void): StoredApp[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as { apps?: unknown }
    if (!Array.isArray(parsed.apps)) return []
    const apps: StoredApp[] = []
    for (const entry of parsed.apps as Array<Record<string, unknown>>) {
      const ceiling = parseCliPermissionPreset(entry?.ceiling)
      if (
        typeof entry?.id !== 'string' ||
        typeof entry.name !== 'string' ||
        typeof entry.tokenHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry.tokenHash) ||
        !ceiling
      )
        continue
      apps.push({
        id: entry.id,
        name: entry.name.slice(0, 80),
        scopes: normalizeStudioScopes(entry.scopes),
        ceiling,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
        lastSeenAt: typeof entry.lastSeenAt === 'string' ? entry.lastSeenAt : null,
        tokenHash: entry.tokenHash,
      })
    }
    return apps
  } catch (error) {
    // Unreadable: no app is paired until the person pairs again. Failing closed
    // is the point; the file is left for someone to look at.
    log?.(`Paired local apps could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

export function createStudioLocalAppStore(options: {
  resolveUserDataDir: () => string
  now?: () => Date
  log?: (message: string) => void
}): StudioLocalAppStore {
  const now = options.now ?? (() => new Date())
  const path = () => join(options.resolveUserDataDir(), STUDIO_LOCAL_APPS_FILENAME)
  let apps = readApps(path(), options.log)
  const pending = new Map<string, Offer>()
  const revokeListeners = new Set<(id: string) => void>()
  const changeListeners = new Set<() => void>()
  let ownerTokenHash: string | null = null
  let ownerTokenValue: string | null = null

  // Written beside and renamed over, so a crash mid-write never leaves a
  // half file that reads back as no apps, or as some.
  function persist(): void {
    const body = `${JSON.stringify({ version: 1, apps }, null, 2)}\n`
    const target = path()
    const staged = `${target}.${process.pid}.tmp`
    writeFileSync(staged, body, { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(staged, 0o600)
    renameSync(staged, target)
  }
  function changed(): void {
    for (const listener of changeListeners) {
      try {
        listener()
      } catch (error) {
        options.log?.(`A local apps listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  function prune(): void {
    const at = now().getTime()
    for (const [id, offer] of pending) if (offer.expiresAtMs <= at) pending.delete(id)
  }

  return {
    list: () => apps.map(publicApp),
    offers() {
      prune()
      return [...pending.values()].map(publicOffer)
    },

    offer(value) {
      const input = parseStudioLocalAppOfferInput(value)
      prune()
      if (pending.size >= MAX_OFFERS) throw new Error('Too many pairing codes are waiting. Cancel one first.')
      if (apps.length >= MAX_APPS) throw new Error(`${MAX_APPS} apps are paired already. Revoke one first.`)
      const code = `sepair_${randomBytes(18).toString('base64url')}`
      const expiresAtMs = now().getTime() + OFFER_TTL_MS
      const offer: Offer = {
        id: `slo_${randomBytes(6).toString('base64url')}`,
        ...input,
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        codeHash: hashSecret(code),
      }
      pending.set(offer.id, offer)
      changed()
      return { offer: publicOffer(offer), code }
    },

    cancelOffer(id) {
      const removed = pending.delete(id)
      if (removed) changed()
      return removed
    },

    redeem(code) {
      prune()
      const presented = hashSecret(code)
      const offer = [...pending.values()].find((candidate) => secretsMatch(presented, candidate.codeHash))
      // One answer for a wrong code and a spent or expired one, and a wrong
      // guess never burns an outstanding code.
      if (!offer) return { ok: false, message: 'That pairing code is not valid. Mint a new one in Studio’s Settings.' }
      // One-time by construction: consumed before anything that could fail.
      pending.delete(offer.id)
      const token = `sest_${randomBytes(32).toString('base64url')}`
      const app: StoredApp = {
        id: `sla_${randomBytes(9).toString('base64url')}`,
        name: offer.name,
        scopes: offer.scopes,
        ceiling: offer.ceiling,
        createdAt: now().toISOString(),
        lastSeenAt: null,
        tokenHash: hashSecret(token),
      }
      apps = [...apps, app]
      try {
        persist()
      } catch (error) {
        apps = apps.filter((candidate) => candidate !== app)
        changed()
        return {
          ok: false,
          message: `The pairing could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      changed()
      return { ok: true, grant: grantOf(app), token }
    },

    authenticate(token) {
      if (!token) return null
      const presented = hashSecret(token)
      if (ownerTokenHash && secretsMatch(presented, ownerTokenHash)) return ownerGrant()
      const app = apps.find((candidate) => secretsMatch(presented, candidate.tokenHash))
      return app ? grantOf(app) : null
    },

    grantFor(clientId) {
      if (clientId === OWNER_CLIENT_ID) return ownerTokenHash ? ownerGrant() : null
      const app = apps.find((candidate) => candidate.id === clientId)
      return app ? grantOf(app) : null
    },

    revoke(id) {
      const next = apps.filter((app) => app.id !== id)
      if (next.length === apps.length) return false
      apps = next
      try {
        // Authorization: a revoke that did not reach disk would come back on
        // the next launch, so the failure reaches the caller.
        persist()
      } finally {
        // Whether or not the write landed, the app is revoked for this run:
        // its connections are closed now, and a failed write is still thrown.
        for (const listener of revokeListeners) {
          try {
            listener(id)
          } catch (error) {
            options.log?.(`A revoke listener threw: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        changed()
      }
      return true
    },

    recordSeen(id) {
      const app = apps.find((candidate) => candidate.id === id)
      if (!app) return
      const seenAtMs = now().getTime()
      const previousMs = app.lastSeenAt ? Date.parse(app.lastSeenAt) : Number.NaN
      app.lastSeenAt = new Date(seenAtMs).toISOString()
      changed()
      if (Number.isFinite(previousMs) && seenAtMs - previousMs < LAST_SEEN_PERSIST_INTERVAL_MS) return
      try {
        persist()
      } catch (error) {
        // Diagnostics, not authorization: a failed write must not fail the connection.
        options.log?.(`A local app's last-seen write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    ownerToken() {
      if (!ownerTokenValue) {
        ownerTokenValue = `seown_${randomBytes(32).toString('base64url')}`
        ownerTokenHash = hashSecret(ownerTokenValue)
      }
      return ownerTokenValue
    },

    onRevoked(listener) {
      revokeListeners.add(listener)
      return () => revokeListeners.delete(listener)
    },
    onChanged(listener) {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    },
  }
}
