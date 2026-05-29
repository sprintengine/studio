// Tier 1 third-party contribution: declarative workspace layout templates.
//
// A layout template is a FlexLayout model (pure JSON) plus display metadata. The
// app feeds `layout` straight to FlexLayout's Model.fromJson — nothing is
// executed — so a third-party template is safe to install (the Tier 1 stance in
// future-plans/2026-05-28-feature-level-pluggable-architecture.md). A template
// that references a panel from a disabled module degrades to an empty surface
// (the WorkspaceLayout factory handles unknown/gated components), so the only
// hard requirement we validate is a structurally-sound FlexLayout root, which is
// what would otherwise throw in Model.fromJson.
//
// Hand-rolled validator (the repo ships no JSON-schema runtime); the
// human/marketplace schema lives at resources/layouts/layout-template.schema.json.

export type LayoutTemplatePreviewSlot = {
  x: number
  y: number
  w: number
  h: number
  type: 'agent' | 'editor' | 'explorer'
  label: string
}

export type LayoutTemplateManifest = {
  id: string
  name: string
  description?: string
  previewSlots?: LayoutTemplatePreviewSlot[]
  /** FlexLayout IJsonModel. Typed as unknown here so shared code stays free of
   *  the renderer's flexlayout dependency; validated structurally below. */
  layout: unknown
}

export type LayoutTemplateValidationIssue = { path: string; message: string }

export type LayoutTemplateValidationResult =
  | { ok: true; manifest: LayoutTemplateManifest }
  | { ok: false; issues: LayoutTemplateValidationIssue[] }

// Template ids allow hyphens (solo-dev, quad-dev), unlike role ids.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const PREVIEW_TYPES = new Set(['agent', 'editor', 'explorer'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validatePreviewSlot(slot: unknown, index: number, issues: LayoutTemplateValidationIssue[]): void {
  if (!isObject(slot)) {
    issues.push({ path: `previewSlots[${index}]`, message: 'preview slot must be an object.' })
    return
  }
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    if (typeof slot[key] !== 'number') {
      issues.push({ path: `previewSlots[${index}].${key}`, message: `${key} must be a number.` })
    }
  }
  if (typeof slot.label !== 'string') {
    issues.push({ path: `previewSlots[${index}].label`, message: 'label must be a string.' })
  }
  if (typeof slot.type !== 'string' || !PREVIEW_TYPES.has(slot.type)) {
    issues.push({
      path: `previewSlots[${index}].type`,
      message: "type must be 'agent', 'editor', or 'explorer'.",
    })
  }
}

export function validateLayoutTemplateManifest(value: unknown): LayoutTemplateValidationResult {
  const issues: LayoutTemplateValidationIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [{ path: '', message: 'Layout template must be a JSON object.' }] }
  }

  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) {
    issues.push({ path: 'id', message: 'id must be lowercase (a–z, 0–9, hyphen), 1–63 chars.' })
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    issues.push({ path: 'name', message: 'name is required and must be a non-empty string.' })
  }
  if ('description' in value && value.description !== undefined && typeof value.description !== 'string') {
    issues.push({ path: 'description', message: 'description must be a string when present.' })
  }

  // FlexLayout root contract: { layout: { type: 'row', children: [...] } }. This
  // is the minimum that keeps Model.fromJson from throwing at workspace creation.
  if (!isObject(value.layout)) {
    issues.push({ path: 'layout', message: 'layout must be a FlexLayout model object.' })
  } else {
    const root = (value.layout as Record<string, unknown>).layout
    if (!isObject(root) || root.type !== 'row') {
      issues.push({ path: 'layout.layout', message: "layout.layout must be a FlexLayout row node (type: 'row')." })
    } else if (!Array.isArray(root.children)) {
      issues.push({ path: 'layout.layout.children', message: 'layout.layout.children must be an array.' })
    }
  }

  if ('previewSlots' in value && value.previewSlots !== undefined) {
    if (!Array.isArray(value.previewSlots)) {
      issues.push({ path: 'previewSlots', message: 'previewSlots must be an array.' })
    } else {
      value.previewSlots.forEach((slot, index) => validatePreviewSlot(slot, index, issues))
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  const manifest: LayoutTemplateManifest = {
    id: value.id as string,
    name: (value.name as string).trim(),
    layout: value.layout,
  }
  if (typeof value.description === 'string') manifest.description = value.description
  if (Array.isArray(value.previewSlots)) {
    manifest.previewSlots = value.previewSlots as LayoutTemplatePreviewSlot[]
  }
  return { ok: true, manifest }
}

export function parseLayoutTemplateManifest(source: string): LayoutTemplateValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '', message: `Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}.` }],
    }
  }
  return validateLayoutTemplateManifest(parsed)
}

// Registry IPC contracts (shared so preload/electron-api can reference them).
export type LayoutTemplateRejection = { path: string; issues: LayoutTemplateValidationIssue[] }

export type UserLayoutTemplateListResult = {
  templates: LayoutTemplateManifest[]
  rejected: LayoutTemplateRejection[]
}

export type LayoutTemplateInstallResult = {
  ok: boolean
  installed: string[]
  rejected: LayoutTemplateRejection[]
  message?: string
}
