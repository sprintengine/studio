import {
  sprintEngineRoleCatalogMaxRoles,
  sprintEngineRoleSummaryMaxChars,
  type MobileControlRoleDescriptor,
  type MobileControlRoleSource,
} from '../../../shared/mobile-control/protocol'
import { readSprintEngineRegistryRoles } from '../../sprintengine-artifacts'

// Publishes the workspace's Sprint Engine role registry to the phone (MC-1543).
//
// The registry is JSON manifests discovered at runtime across four layers, so the
// phone cannot know the role set at build time — it has to be told, or its launch
// picker can only ever offer the roles that were bundled when it shipped. This
// module is the producer: read the registry the desktop reads, reduce each manifest
// to what a picker needs, and hand it to the snapshot.
//
// Reducing is the point. A manifest carries directives and skill routing; none of
// that is the phone's business (it stages a roster, it does not compose an agent),
// and the snapshot rides the relay's result-summary budget, which the size-shedding
// pass can only reclaim by dropping whole sprint engines. So: id, label, the
// manifest description (truncated onto the wire's `summary` field), layer. Nothing
// else.

export type RoleCatalogReader = (workspaceRoot: string) => Promise<MobileControlRoleDescriptor[] | undefined>

// Reading the registry spawns a Python MCP process. Snapshots publish on a ~1s
// throttle and once per workspace, so an uncached read would spawn an interpreter
// per workspace per second — for data that changes when a user edits a JSON file.
// Cache it.
const roleCatalogTtlMs = 60_000

// A failing read is cached too, and backs off: a desktop with a broken Python
// runtime would otherwise spawn one doomed process per workspace every retry
// window, forever, for a feature that will never succeed there. Back off to a
// ceiling instead, and let a registry write (clearRoleCatalogCache) reset it.
const roleCatalogFailureTtlMs = 10_000
const roleCatalogFailureTtlCeilingMs = 300_000

// The read runs on the snapshot publish path, so it must be bounded. Generous —
// a cold Python interpreter on a big workspace is not fast — but finite.
const roleCatalogReadTimeoutMs = 20_000

type CacheEntry = { expiresAt: number; roles: MobileControlRoleDescriptor[] | undefined }

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<MobileControlRoleDescriptor[] | undefined>>()
const consecutiveFailures = new Map<string, number>()

// A read that was already in flight when the registry changed is reading the *old*
// registry, and must not be allowed to land in the cache afterwards — that would
// pin the pre-change roles for a full TTL. Stamp each read with the generation it
// started in and drop its result if the generation moved under it.
let generation = 0

/** Drops the cache. Tests, and any surface that has just written a role. */
export function clearRoleCatalogCache(): void {
  generation += 1
  cache.clear()
  inFlight.clear()
  consecutiveFailures.clear()
}

// Back off 10s, 20s, 40s… to a 5-minute ceiling while a workspace keeps failing.
function failureTtlMs(workspaceRoot: string): number {
  const failures = consecutiveFailures.get(workspaceRoot) ?? 0
  return Math.min(roleCatalogFailureTtlMs * 2 ** Math.min(failures, 10), roleCatalogFailureTtlCeilingMs)
}

export const readWorkspaceRoleCatalog: RoleCatalogReader = async (workspaceRoot) => {
  const cached = cache.get(workspaceRoot)
  if (cached && cached.expiresAt > Date.now()) return cached.roles

  // Concurrent snapshot reads for the same workspace share one process.
  const pending = inFlight.get(workspaceRoot)
  if (pending) return pending

  const startedAt = generation
  const read = (async () => {
    let roles: MobileControlRoleDescriptor[] | undefined
    try {
      // Bounded: this runs on the publish path, and an unbounded read that never
      // settles would pin this very promise in `inFlight` and hand it to every
      // later snapshot — a dead phone until the app restarts.
      const result = await readSprintEngineRegistryRoles({ workspaceRoot }, roleCatalogReadTimeoutMs)
      roles = result.ok ? normalizeRoleCatalog(result.data) : undefined
    } catch {
      // The catalog is an enhancement: a workspace whose registry cannot be read
      // still publishes a snapshot, and the phone falls back to its bundled list.
      roles = undefined
    }
    if (startedAt === generation) {
      // Read the failure count before bumping it, so the first failure waits the
      // base window rather than already-doubled.
      const ttl = roles ? roleCatalogTtlMs : failureTtlMs(workspaceRoot)
      if (roles) {
        consecutiveFailures.delete(workspaceRoot)
      } else {
        consecutiveFailures.set(workspaceRoot, (consecutiveFailures.get(workspaceRoot) ?? 0) + 1)
      }
      cache.set(workspaceRoot, { expiresAt: Date.now() + ttl, roles })
      inFlight.delete(workspaceRoot)
    }
    return roles
  })()

  inFlight.set(workspaceRoot, read)
  return read
}

// `sprintengine.roles.list` payload -> wire descriptors. Exported for the tests,
// which drive it with real tool output rather than a hand-built object.
export function normalizeRoleCatalog(input: unknown): MobileControlRoleDescriptor[] | undefined {
  const rawRoles = isRecord(input) ? input.roles : undefined
  if (!Array.isArray(rawRoles)) return undefined

  const descriptors: MobileControlRoleDescriptor[] = []
  const seen = new Set<string>()

  for (const raw of rawRoles) {
    if (!isRecord(raw)) continue
    const roleId = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!roleId || seen.has(roleId)) continue
    seen.add(roleId)

    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : humanizeRoleId(roleId)
    // MC-1831 renamed the manifest's one-line `summary` to a fuller `description`.
    // The wire field stays `summary` — protocol.ts is a byte-identical mirror of
    // the mobile app's copy — so the picker gets the description, truncated to the
    // same budget. A manifest read by an older engine simply has no description
    // and the picker renders the label alone.
    const summary = typeof raw.description === 'string' ? truncate(raw.description.trim()) : ''
    // MC-1886 removed the sweep concept, so no descriptor carries `sweep` any
    // more. The wire field stays declared in protocol.ts (a byte-identical
    // mirror of the mobile app's copy) for one release, so a phone build that
    // still reads it simply sees an absent key.
    const source = roleSource(raw.source)

    descriptors.push({
      roleId,
      label,
      ...(summary ? { summary } : {}),
      ...(source ? { source } : {}),
    })

    if (descriptors.length >= sprintEngineRoleCatalogMaxRoles) break
  }

  return descriptors
}

// The user-global registry is mounted as a *plugin* root (`plugin:user-roles`, see
// sprintEngineRegistryRootsForRead), so the raw layer name would tell the phone
// "plugin" for the very roles the user authored themselves. Map it back to what it
// means to a person; other plugin layers collapse to a bare "plugin".
function roleSource(input: unknown): MobileControlRoleSource | undefined {
  const layer = isRecord(input) && typeof input.layer === 'string' ? input.layer.trim() : ''
  if (!layer) return undefined
  if (layer === 'plugin:user-roles') return 'user'
  if (layer.startsWith('plugin:')) return 'plugin'
  if (layer === 'bundled' || layer === 'workspace' || layer === 'user' || layer === 'plugin') return layer
  return undefined
}

function truncate(value: string): string {
  if (value.length <= sprintEngineRoleSummaryMaxChars) return value
  return `${value.slice(0, sprintEngineRoleSummaryMaxChars - 1).trimEnd()}…`
}

// Mirrors the phone's roleLabel() fallback, for a manifest with no label.
function humanizeRoleId(roleId: string): string {
  const cleaned = roleId.replace(/[_-]+/gu, ' ').trim()
  if (!cleaned) return roleId
  return cleaned
    .split(/\s+/u)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
