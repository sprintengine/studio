// A CLI's model catalog read as the pickers read it: one row per model, with
// the context windows the catalog offers for it as a second axis. Pure and
// Node-free, so the desktop's picker (cliRuntimeCatalog.ts re-exports these)
// and `cli.runtime.list`, which hands a paired phone the same picker, group the
// same catalog the same way.
//
// A CLI declares window variants of a model as sibling catalog ids that differ
// only by a bracketed suffix — claude-code ships `claude-opus-5` beside
// `claude-opus-5[1m]`, which is the same model at two context windows, not two
// models. Rendering both as peer rows is what made the old listbox read as a
// wall of near-duplicates. So a model's variants group into one family row and
// the window choice moves to the reasoning selector beside it, where it is a
// second axis rather than a second name.

import type { MergedCliModelOption } from './cli-model-catalog'
import type { PluginModelOption } from './plugin-manifest'

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
function windowVariantLabel(window: string | undefined): string {
  return window ? window.toUpperCase() : 'Standard'
}

type ModelWindowVariant = {
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
  /** Any of its ids was first listed on this machine recently: what the picker's "New" chip reads. */
  isNew?: boolean
}

// Group a CLI's model options into families. Catalog order is preserved by
// first appearance, so a merged catalog (the CLI's list or the seed, then user, see
// mergeCliModelCatalog) still reads in the order it was built.
export function buildModelFamilies(
  options: ReadonlyArray<PluginModelOption & { isNew?: boolean }> | undefined,
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
    if (option.isNew) family.isNew = true
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

/**
 * One catalog id as a client that draws the picker itself needs it: the id
 * and its label, which family row it sits under, and the name of its window.
 */
export type CliPickerModel = {
  id: string
  label?: string
  /** The family it is grouped under: every id with the same `family` is one row. */
  family: string
  /** Whether this is the id the family's row selects, and whose label names the row. */
  familyDefault: boolean
  /** The window this id pins, as the picker names it: `1M`, or `Standard` for the model's own. */
  contextLabel: string
  /** The picker marks the family's row New: one of its ids was first listed here recently. */
  isNew?: true
  /** Where the id came from: what the CLI reported, its manifest seed, or the person's own list. */
  origin: MergedCliModelOption['origin']
}

/**
 * The merged catalog, flattened in the picker's order, each id marked with the
 * family row it renders under. Families come in the order the picker lists
 * them, and within one, base window first, as its window selector lists them.
 * A label rides only on the entry whose catalog row had one.
 */
export function cliPickerModels(options: readonly MergedCliModelOption[]): CliPickerModel[] {
  const byId = new Map(options.map((option) => [option.id.trim(), option]))
  const models: CliPickerModel[] = []
  for (const family of buildModelFamilies(options)) {
    for (const variant of family.variants) {
      const option = byId.get(variant.id)
      if (!option) continue
      const label = option.label?.trim()
      models.push({
        id: variant.id,
        ...(label ? { label } : {}),
        family: family.baseId,
        familyDefault: variant.id === family.defaultId,
        contextLabel: variant.label,
        ...(family.isNew ? { isNew: true as const } : {}),
        origin: option.origin,
      })
    }
  }
  return models
}
