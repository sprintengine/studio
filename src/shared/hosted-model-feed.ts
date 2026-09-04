// The hosted model feed: `model-feed.json` at the root of the public
// sprintengine/studio-releases repo, edited there by pull request, fetched raw
// by every running studio and rendered by sprintengine.ai/models. It is how a
// model reaches every picker without an app release — a model list that can
// only change with a release is stale the week a provider ships.
//
// Node-free on purpose: `src/shared` cannot import `src/main` (TS6307). The
// fetcher, cache, and poller live in src/main/hosted-feed.
//
// The schema is a permanent contract: builds that are years old will keep
// reading it. Add fields; never remove or repurpose one. A body whose
// `schemaVersion` is not one this build knows is rejected whole, and the
// client keeps its last good copy.

export const HOSTED_MODEL_FEED_SCHEMA_VERSION = 1 as const

export const HOSTED_MODEL_FEED_URL =
  'https://raw.githubusercontent.com/sprintengine/studio-releases/main/model-feed.json'

// "New" is one rule everywhere: the picker chip and the website badge both
// read `releasedAt` against this window. No per-machine state.
export const HOSTED_MODEL_NEW_FOR_DAYS = 30

export type HostedModel = {
  // The exact string passed to the CLI's `--model` (or its equivalent).
  id: string
  label: string
  description?: string
  contextWindow?: number
  effortLevels?: string[]
  defaultEffort?: string
  supportsFastMode?: boolean
  // ISO date. Drives "New". Absent on aliases, which float.
  releasedAt?: string
  // A floating id like `opus[1m]` that tracks whatever is newest.
  alias?: boolean
  // A retired row hides the manifest row of the same id and is not shown
  // itself. Rows are never deleted from the feed, so a build that still ships
  // the id in its manifest can be told to stop offering it.
  retired?: boolean
  retiredAt?: string
}

export type HostedModelFeed = {
  schemaVersion: typeof HOSTED_MODEL_FEED_SCHEMA_VERSION
  // Bumped on every edit. The tie-break between a bundled seed and a disk
  // cache: whichever was edited later wins, regardless of when it was fetched.
  updatedAt: string
  // Keyed by studio plugin id (`claude-code`, `codex`, ...), never by vendor.
  clis: Record<string, { models: HostedModel[] }>
}

// The picker-facing shape: hosted rows per plugin id, ready for the merge in
// cliRuntimeOptions.mergeModelCatalog.
export type HostedCliModelCatalogs = Partial<Record<string, HostedModel[]>>

export type HostedModelFeedParseResult =
  | { ok: true; feed: HostedModelFeed }
  | { ok: false; message: string }

export function parseHostedModelFeed(source: unknown): HostedModelFeedParseResult {
  let value: unknown = source
  if (typeof source === 'string') {
    try {
      value = JSON.parse(source)
    } catch (error) {
      return { ok: false, message: `Model feed is not valid JSON. ${formatError(error)}` }
    }
  }
  if (!isObject(value)) return { ok: false, message: 'Model feed must be a JSON object.' }
  if (value.schemaVersion !== HOSTED_MODEL_FEED_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `Model feed schemaVersion ${JSON.stringify(value.schemaVersion)} is not one this build reads (${HOSTED_MODEL_FEED_SCHEMA_VERSION}).`,
    }
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    return { ok: false, message: 'Model feed updatedAt must be an ISO date-time.' }
  }
  if (!isObject(value.clis)) return { ok: false, message: 'Model feed clis must be an object keyed by plugin id.' }

  const clis: HostedModelFeed['clis'] = {}
  for (const [cli, entry] of Object.entries(value.clis)) {
    const id = cli.trim()
    if (!id) continue
    if (!isObject(entry) || !Array.isArray(entry.models)) {
      return { ok: false, message: `Model feed ${cli}.models must be an array.` }
    }
    const seen = new Set<string>()
    const models: HostedModel[] = []
    for (const [index, raw] of entry.models.entries()) {
      const parsed = parseModel(raw)
      if (!parsed.ok) return { ok: false, message: `Model feed ${cli}.models[${index}]: ${parsed.message}` }
      if (seen.has(parsed.model.id)) {
        return { ok: false, message: `Model feed ${cli}.models has duplicate id "${parsed.model.id}".` }
      }
      seen.add(parsed.model.id)
      models.push(parsed.model)
    }
    clis[id] = { models }
  }
  return { ok: true, feed: { schemaVersion: HOSTED_MODEL_FEED_SCHEMA_VERSION, updatedAt: value.updatedAt, clis } }
}

function parseModel(raw: unknown): { ok: true; model: HostedModel } | { ok: false; message: string } {
  if (!isObject(raw)) return { ok: false, message: 'row must be an object.' }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return { ok: false, message: 'id must be a non-empty string.' }
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id
  const model: HostedModel = { id, label }
  if (typeof raw.description === 'string' && raw.description.trim()) model.description = raw.description.trim()
  if (typeof raw.contextWindow === 'number' && Number.isFinite(raw.contextWindow) && raw.contextWindow > 0) {
    model.contextWindow = raw.contextWindow
  }
  if (Array.isArray(raw.effortLevels) && raw.effortLevels.every((level) => typeof level === 'string')) {
    model.effortLevels = raw.effortLevels as string[]
  }
  if (typeof raw.defaultEffort === 'string' && raw.defaultEffort.trim()) model.defaultEffort = raw.defaultEffort.trim()
  if (typeof raw.supportsFastMode === 'boolean') model.supportsFastMode = raw.supportsFastMode
  if (typeof raw.releasedAt === 'string' && !Number.isNaN(Date.parse(raw.releasedAt))) model.releasedAt = raw.releasedAt
  if (raw.alias === true) model.alias = true
  if (raw.retired === true) model.retired = true
  if (typeof raw.retiredAt === 'string' && !Number.isNaN(Date.parse(raw.retiredAt))) model.retiredAt = raw.retiredAt
  return { ok: true, model }
}

// Epoch millis of `updatedAt`, or 0 when unparsable: an undated copy loses
// every tie-break.
export function hostedModelFeedUpdatedAtMs(feed: Pick<HostedModelFeed, 'updatedAt'>): number {
  const parsed = Date.parse(feed.updatedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function isRecentRelease(releasedAt: string | null | undefined, now: Date, days = HOSTED_MODEL_NEW_FOR_DAYS): boolean {
  if (!releasedAt) return false
  const released = Date.parse(releasedAt)
  if (Number.isNaN(released)) return false
  const age = now.getTime() - released
  return age >= 0 && age < days * 24 * 60 * 60 * 1000
}

export function isNewHostedModel(model: HostedModel, now: Date, days = HOSTED_MODEL_NEW_FOR_DAYS): boolean {
  if (model.alias === true || model.retired === true) return false
  return isRecentRelease(model.releasedAt, now, days)
}

export function hostedModelsByCli(feed: HostedModelFeed | null | undefined): HostedCliModelCatalogs {
  const out: HostedCliModelCatalogs = {}
  if (!feed) return out
  for (const [cli, entry] of Object.entries(feed.clis)) out[cli] = entry.models
  return out
}

// Ids present in `next` that `previous` did not have, per CLI — what the
// "New models for Claude Code" notice names. Retired rows never count.
export function hostedModelAdditions(
  previous: HostedModelFeed | null | undefined,
  next: HostedModelFeed,
): Record<string, HostedModel[]> {
  const out: Record<string, HostedModel[]> = {}
  for (const [cli, entry] of Object.entries(next.clis)) {
    const before = new Set((previous?.clis[cli]?.models ?? []).map((model) => model.id))
    const added = entry.models.filter((model) => model.retired !== true && !before.has(model.id))
    if (added.length > 0) out[cli] = added
  }
  return out
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
