import type { AgentCli, AppSettings, SprintEngineModelCatalogEntry } from '../types/workspace'

// Pure, node-free helpers for the global Sprint Engine model catalog. This is
// the single read path for the wizard's per-sprint model selection and the
// architect-seat default; the Settings UI writes through the store setter,
// which normalizes with `normalizeSprintEngineModelCatalog`.

// Default when the axis or cost is missing/invalid — a neutral mid-scale score
// and a 1× cost multiplier.
const DEFAULT_AXIS = 5
const AXIS_MIN = 1
const AXIS_MAX = 10
const DEFAULT_COST = 1

// Clamp a 1–10 rating to an in-range integer. Non-numbers, NaN, and Infinity
// fall back to the neutral default rather than propagating a bad score.
function normalizeAxis(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_AXIS
  return Math.min(AXIS_MAX, Math.max(AXIS_MIN, Math.round(value)))
}

// Cost is a positive relative multiplier (ratio semantics). Zero, negatives,
// and non-finite values are meaningless as a ratio, so they reset to 1×.
function normalizeCost(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_COST
  return value
}

// A model id is either a concrete string or null (the CLI's own default). Blank
// or whitespace-only strings collapse to null so an empty picker input means
// "CLI default" rather than a distinct empty-string model.
function normalizeModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

// Dedupe key over cli+model. JSON encoding is injective over (string, string|null),
// so null (CLI default) stays distinct from every string model — including one
// that happens to look like a separator — with no fragile sentinel.
function catalogEntryKey(cli: string, model: string | null): string {
  return JSON.stringify([cli, model])
}

export function normalizeSprintEngineModelCatalog(value: unknown): SprintEngineModelCatalogEntry[] {
  if (!Array.isArray(value)) return []
  const result: SprintEngineModelCatalogEntry[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Partial<SprintEngineModelCatalogEntry>
    const cli = typeof candidate.cli === 'string' ? candidate.cli.trim() : ''
    if (!cli) continue
    const model = normalizeModelId(candidate.model)
    const key = catalogEntryKey(cli, model)
    if (seen.has(key)) continue
    seen.add(key)
    const note = typeof candidate.note === 'string' ? candidate.note.trim() : ''
    result.push({
      cli,
      model,
      // Missing ⇒ offered by default; any present value is coerced to boolean.
      offeredByDefault: candidate.offeredByDefault === undefined ? true : Boolean(candidate.offeredByDefault),
      intelligence: normalizeAxis(candidate.intelligence),
      frontendDesign: normalizeAxis(candidate.frontendDesign),
      mobile: normalizeAxis(candidate.mobile),
      speed: normalizeAxis(candidate.speed),
      cost: normalizeCost(candidate.cost),
      // Omit the key when empty so entries without a note keep a clean shape.
      ...(note ? { note } : {}),
    })
  }
  return result
}

// The single availability-gated read path. Filters the catalog to entries whose
// CLI is in `installedClis` (the detected installed-CLI set), so an uninstalled
// CLI's models can never be selected for a sprint and then fail to spawn.
// Settings keeps unavailable entries visible (greyed) by reading the raw array;
// everything that selects a model for a run reads this instead.
export function getAvailableModelCatalogEntries(
  settings: Pick<AppSettings, 'sprintEngineModelCatalog'>,
  installedClis: Iterable<AgentCli>,
): SprintEngineModelCatalogEntry[] {
  const installed = new Set(installedClis)
  return settings.sprintEngineModelCatalog.filter((entry) => installed.has(entry.cli))
}
