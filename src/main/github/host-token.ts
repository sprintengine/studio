// A token for a GitHub host other than github.com — a company's self-hosted
// GitHub — read from the GitHub CLI's own sign-in for that host.
//
// The app's stored token belongs to github.com and must never be sent anywhere
// else, and asking someone to paste a second token for every host they work
// against duplicates a sign-in they already have: `gh auth login --hostname`
// is how the rest of this app reaches an enterprise host (`gh.ts`), and
// `gh auth token --hostname` hands that same credential back without a prompt.
//
// ONLY a sign-in gh stored for that host counts. gh answers `auth token` for
// ANY host out of GH_ENTERPRISE_TOKEN / GITHUB_ENTERPRISE_TOKEN (and GITHUB_TOKEN
// in a codespace) when one is exported, so asking with those in the
// environment would hand a company token to whatever host was typed — a typo
// of the company's hostname included. They are unset for the call.
//
// A token is remembered for a few minutes: a repository read runs dozens of
// git commands, each asking for its host's token, and a `gh` spawn per
// command would cost more
// than the reads themselves. "No sign-in" is remembered only for a moment, so
// someone who runs `gh auth login` because the read told them to and presses
// Try again is read with it.

import type { GhRunner } from './gh'

const HOST_TOKEN_TTL_MS = 5 * 60 * 1000
const NO_HOST_TOKEN_TTL_MS = 10_000
const HOST_TOKEN_TIMEOUT_MS = 10_000
const ENV_TOKENS = ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const

export type GhHostTokenResolver = (host: string) => Promise<string>

export function createGhHostTokenResolver(
  gh: GhRunner,
  options: { ttlMs?: number; emptyTtlMs?: number; now?: () => number } = {},
): GhHostTokenResolver {
  const ttlMs = options.ttlMs ?? HOST_TOKEN_TTL_MS
  const emptyTtlMs = options.emptyTtlMs ?? NO_HOST_TOKEN_TTL_MS
  const now = options.now ?? Date.now
  const remembered = new Map<string, { token: string; at: number }>()
  const inFlight = new Map<string, Promise<string>>()

  const ask = async (host: string): Promise<string> => {
    const result = await gh.run(['auth', 'token', '--hostname', host], {
      timeoutMs: HOST_TOKEN_TIMEOUT_MS,
      unsetEnv: ENV_TOKENS,
    })
    // Only a clean answer is a token: gh prints its complaint about a host it
    // has no sign-in for on stderr and exits non-zero.
    const token = result.found && result.code === 0 && !result.timedOut ? result.stdout.trim() : ''
    return /^\S+$/.test(token) ? token : ''
  }

  return async (rawHost) => {
    const host = rawHost.trim().toLowerCase()
    if (!host) return ''
    const hit = remembered.get(host)
    if (hit && now() - hit.at < (hit.token ? ttlMs : emptyTtlMs)) return hit.token
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
