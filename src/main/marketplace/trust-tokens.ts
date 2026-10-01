import { randomBytes } from 'node:crypto'

import type { GithubExtensionOrigin, MarketplaceTrustPin } from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'

// The trust decision a person takes at an install prompt, held in main.
//
// The prompt used to answer with a boolean the renderer sent back
// (`trustGranted: true`) beside a registry entry the renderer also sent back,
// so anything that could reach the IPC could install any entry it liked —
// an MCP server whose command is `sh -c …` included — by saying yes on
// somebody's behalf. Now `verify` is the only thing that can say yes: it
// resolves the entry itself, discloses what it found, and hands the renderer
// an opaque token naming that entry and a pin of the exact content disclosed.
// The install spends the token. It is one-time, expires, and never leaves
// this process, so the renderer can carry the decision but never forge it.

export type TrustPin = MarketplaceTrustPin

// Where the entry a token names came from. `registry` is the app's own
// marketplace index; `github` is an entry synthesised from a repository URL,
// which is not in any registry, so the token carries the entry itself.
export type TrustSource = 'registry' | 'github'

export type TrustGrant = {
  entryId: string
  source: TrustSource
  pin: TrustPin
  // Unsigned module code may install only from a URL the person typed, and
  // only after they said so in as many words: true only when the issuer asked
  // for it AND the source is 'github'. The registry path keeps refusing
  // unsigned code whatever a token says.
  allowUnsignedCode: boolean
  // The entry the disclosure was read from, resolved in main. The install
  // uses this rather than reading the registry again, so a registry refresh
  // between the prompt and the click cannot change what gets installed.
  entry?: MarketplacePluginEntry
  // The repository a `github` entry was resolved from, as the person named
  // it, so its receipt can say where updates come from. Kept only when the
  // source is 'github'.
  github?: GithubExtensionOrigin
}

export type IssueTrustTokenInput = {
  entryId: string
  source: TrustSource
  pin: TrustPin
  allowUnsignedCode?: boolean
  entry?: MarketplacePluginEntry
  github?: GithubExtensionOrigin
}

export const TRUST_TOKEN_TTL_MS = 10 * 60 * 1000

export type TrustTokenStore = {
  issue(input: IssueTrustTokenInput): string
  // Spends the token: whatever the answer, the token is gone afterwards. A
  // token presented for a different entry than it was issued for is burned
  // too — a mismatch is a caller that should not have had it.
  consume(token: string, entryId: string): TrustGrant | null
  // What a token names, without spending it — for a caller whose request
  // carries only the token (an install from a GitHub URL) and has to know
  // which entry to consume it for.
  peek(token: string): { entryId: string; source: TrustSource } | null
}

export function createTrustTokenStore(options: { now?: () => number; ttlMs?: number } = {}): TrustTokenStore {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? TRUST_TOKEN_TTL_MS
  const tokens = new Map<string, { grant: TrustGrant; expiresAt: number }>()

  function prune(): void {
    const at = now()
    for (const [token, held] of tokens) if (held.expiresAt <= at) tokens.delete(token)
  }

  function live(token: string): { grant: TrustGrant; expiresAt: number } | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const held = tokens.get(token)
    if (!held) return null
    if (held.expiresAt <= now()) {
      tokens.delete(token)
      return null
    }
    return held
  }

  return {
    issue(input) {
      prune()
      const token = randomBytes(32).toString('base64url')
      tokens.set(token, {
        grant: {
          entryId: input.entryId,
          source: input.source,
          pin: { ...input.pin, componentDigests: { ...input.pin.componentDigests } },
          allowUnsignedCode: input.allowUnsignedCode === true && input.source === 'github',
          ...(input.entry ? { entry: input.entry } : {}),
          ...(input.github && input.source === 'github' ? { github: { ...input.github } } : {}),
        },
        expiresAt: now() + ttlMs,
      })
      return token
    },
    consume(token, entryId) {
      const held = live(token)
      if (!held) return null
      tokens.delete(token)
      return held.grant.entryId === entryId ? held.grant : null
    },
    peek(token) {
      const held = live(token)
      return held ? { entryId: held.grant.entryId, source: held.grant.source } : null
    },
  }
}

// Whether the content an install staged is the content the prompt disclosed.
// The commit is where to fetch, not what was shown: a seed fallback has none,
// and a download at the pinned commit matches it by construction, so only the
// digests are compared.
export function trustPinsMatch(disclosed: TrustPin, staged: TrustPin): boolean {
  if (disclosed.manifestSha256 !== staged.manifestSha256) return false
  const a = Object.entries(disclosed.componentDigests)
  const b = staged.componentDigests
  if (a.length !== Object.keys(b).length) return false
  return a.every(([path, digest]) => b[path] === digest)
}

// One store per main process: a token is only ever spent by the process that
// issued it.
const processStore = createTrustTokenStore()

export function issueTrustToken(input: IssueTrustTokenInput): string {
  return processStore.issue(input)
}

export function consumeTrustToken(token: string, entryId: string): TrustGrant | null {
  return processStore.consume(token, entryId)
}

export function peekTrustToken(token: string): { entryId: string; source: TrustSource } | null {
  return processStore.peek(token)
}
