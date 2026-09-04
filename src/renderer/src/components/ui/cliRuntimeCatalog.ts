// Catalog reading for the runtime pickers. Pure functions over the
// renderer-facing plugin catalog (`PluginModelCatalog` / `PluginReasoningCatalog`)
// — this module reads the catalog and never changes it.
//
// Its one non-obvious job is the context-window axis. A CLI declares window
// variants of a model as sibling catalog ids that differ only by a bracketed
// suffix — claude-code ships `claude-opus-5` beside `claude-opus-5[1m]`, which
// is the same model at two context windows, not two models. Rendering both as
// peer rows is what made the old listbox read as a wall of near-duplicates. So
// the picker groups a model's variants into one family row and hands the window
// choice to the reasoning selector beside it, where it is a second axis rather
// than a second name.

import type { AgentCli } from '../../types/workspace'
import type {
  PluginModelCatalog,
  PluginModelOption,
  PluginReasoningCatalog,
} from '../../../../shared/plugin-manifest'

// Structurally compatible with AgentCliCatalogOption from
// newWorkspace/cliRuntimeOptions; declared here so the ui primitive does not
// import from a workspace module.
export type CliRuntimeOption = {
  value: AgentCli
  label: string
  modelSelection?: PluginModelCatalog
  reasoningSelection?: PluginReasoningCatalog
  hostedVia?: 'claude-code'
}

// A model's raw id, shown beside its friendly label only when it adds
// information the label does not already carry — `opus[1m]` beside "Opus"
// stays, `gpt-5.5` beside "GPT-5.5" goes. The test is one-directional: the id
// is dropped when the LABEL already spells out everything the id says, ignoring
// case and separators. It is kept whenever the id carries something the name
// does not, because that something (a context-window variant, a vendor
// namespace) is exactly what a person needs to tell two rows apart.
export function meaningfulModelId(id: string, label: string | undefined): string | undefined {
  if (!label) return undefined // the row already renders the bare id in the mono face
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const normalizedId = normalize(id)
  const normalizedLabel = normalize(label)
  if (!normalizedId || !normalizedLabel) return undefined
  return normalizedLabel.includes(normalizedId) ? undefined : id
}

const WINDOW_SUFFIX = /^(.+)\[([^\]]+)\]$/

// Split a catalog id into the model it names and the context window it pins.
// `claude-opus-5[1m]` → base `claude-opus-5`, window `1m`. An id with no
// bracketed suffix is the model at its own standard window.
export function parseModelWindow(id: string): { baseId: string; window?: string } {
  const trimmed = id.trim()
  const match = WINDOW_SUFFIX.exec(trimmed)
  if (!match) return { baseId: trimmed }
  return { baseId: match[1]!, window: match[2]! }
}

// The window's visible name. The suffix is the only thing the catalog says
// about the window, so it is what the option reads as — uppercased, because
// `1m` is a token, not a word. The un-suffixed id is the model's own window,
// which the catalog never names; "Standard" is what it is called against the
// extended sibling that does carry a name.
export function windowVariantLabel(window: string | undefined): string {
  return window ? window.toUpperCase() : 'Standard'
}

export type ModelWindowVariant = {
  /** The catalog id this window selects. */
  id: string
  label: string
  /** True for the un-suffixed id — the model at the window the CLI defaults to. */
  base: boolean
}

// One model, with every context window the catalog offers for it.
export type CliModelFamily = {
  baseId: string
  /** The id a row selects when the family is chosen with no window in mind. */
  defaultId: string
  /** Friendly name; absent when no catalog entry labelled it (row renders the id in mono). */
  label?: string
  /** Ordered base-first. A single entry means this model has no window axis. */
  variants: ModelWindowVariant[]
  /** From the hosted feed, when it dated the row: what the picker's "New" chip reads. */
  releasedAt?: string
}

// Group a CLI's model options into families. Catalog order is preserved by
// first appearance, so a merged catalog (manifest → discovered → user, see
// cliRuntimeOptions.mergeModelCatalog) still reads in the order it was built.
export function buildModelFamilies(
  options: ReadonlyArray<PluginModelOption & { releasedAt?: string }> | undefined,
): CliModelFamily[] {
  if (!options) return []
  const families = new Map<string, CliModelFamily>()
  for (const option of options) {
    const id = option.id.trim()
    if (!id) continue
    const { baseId, window } = parseModelWindow(id)
    let family = families.get(baseId)
    if (!family) {
      family = { baseId, defaultId: id, label: option.label, variants: [] }
      families.set(baseId, family)
    }
    if (family.variants.some((variant) => variant.id === id)) continue
    family.variants.push({ id, label: windowVariantLabel(window), base: !window })
    // The un-suffixed entry names the family and is what its row selects. A
    // family the catalog only ships suffixed (claude-code's floating
    // `opus[1m]`) keeps its own id and label in both roles, so it stays a
    // first-class row rather than a headless variant group.
    if (!window) {
      family.defaultId = id
      family.label = option.label
    }
    if (option.releasedAt && (!window || !family.releasedAt)) family.releasedAt = option.releasedAt
  }
  for (const family of families.values()) {
    family.variants.sort((a, b) => Number(b.base) - Number(a.base))
  }
  return [...families.values()]
}

// The family a selected model id belongs to, or undefined when the id is not in
// this catalog at all (a persisted model the CLI has since dropped).
export function familyForModel(
  families: ReadonlyArray<CliModelFamily>,
  modelId: string | undefined,
): CliModelFamily | undefined {
  if (!modelId) return undefined
  return families.find((family) => family.variants.some((variant) => variant.id === modelId))
}
