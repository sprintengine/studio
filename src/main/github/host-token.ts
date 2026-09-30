// A token for a GitHub host other than github.com — a company's self-hosted
// GitHub — read from the GitHub CLI's own sign-in for that host.
//
// The app's stored token belongs to github.com and must never be sent anywhere
// else, and asking someone to paste a second token for every host they work
// against duplicates a sign-in they already have: `gh auth login --hostname`
// is how the rest of this app reaches an enterprise host (`gh.ts`), and
// `gh auth token --hostname` hands that same credential back without a prompt.
//
// The answer is remembered for a few minutes, the empty one included. A
// repository read runs dozens of git commands, each asking for its host's
// token, and a `gh` spawn — through a login shell when the binary is not on
// PATH — per command would cost more than the reads themselves.

import type { GhRunner } from './gh'

const HOST_TOKEN_TTL_MS = 5 * 60 * 1000
const HOST_TOKEN_TIMEOUT_MS = 10_000

export type GhHostTokenResolver = (host: string) => Promise<string>

export function createGhHostTokenResolver(
  gh: GhRunner,
  options: { ttlMs?: number; now?: () => number } = {},
): GhHostTokenResolver {
  const ttlMs = options.ttlMs ?? HOST_TOKEN_TTL_MS
  const now = options.now ?? Date.now
  const remembered = new Map<string, { token: string; at: number }>()
  const inFlight = new Map<string, Promise<string>>()

  const ask = async (host: string): Promise<string> => {
    const result = await gh.run(['auth', 'token', '--hostname', host], { timeoutMs: HOST_TOKEN_TIMEOUT_MS })
    // Only a clean answer is a token: gh prints its complaint about a host it
    // has no sign-in for on stderr and exits non-zero.
    const token = result.found && result.code === 0 && !result.timedOut ? result.stdout.trim() : ''
    return /^\S+$/.test(token) ? token : ''
  }

  return async (rawHost) => {
    const host = rawHost.trim().toLowerCase()
    if (!host) return ''
    const hit = remembered.get(host)
    if (hit && now() - hit.at < ttlMs) return hit.token
    const pending = inFlight.get(host)
    if (pending) return pending
    const asking = ask(host)
      .catch(() => '')
      .then((token) => {
        remembered.set(host, { token, at: now() })
        return token
      })
      .finally(() => inFlight.delete(host))
    inFlight.set(host, asking)
    return asking
  }
}
