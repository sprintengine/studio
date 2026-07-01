export const DESIGN_SYSTEM_MANIFEST_FILENAME = 'design-system.json'
export const DESIGN_SYSTEM_SCHEMA_VERSION = 1

export interface DesignSystemContents extends Record<string, unknown> {
  foundations: string[]
  components: string[]
  patterns: string[]
  glyphs: string[]
  assets: string[]
}

export interface DesignSystemProvenance extends Record<string, unknown> {
  authoredBy?: string | null
  sourceLibraryId?: string | null
  sourceLibraryVersion?: string | null
  releasedAt?: string | null
  attachedAt?: string | null
}

export interface DesignSystemManifest extends Record<string, unknown> {
  schemaVersion: number
  name: string
  version: string
  summary: string
  modes: string[]
  namingGrammar: Record<string, string>
  contents: DesignSystemContents
  derived: Record<string, string>
  provenance: DesignSystemProvenance
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function requireStringMap(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new Error(`design-system.json: "${field}" must be an object of string values`)
  }
  return value as Record<string, string>
}

/**
 * Parses and validates a design-system.json manifest. Unknown fields are
 * preserved verbatim (forward compatibility is part of the schema contract —
 * see knowledge/multicode/design-system-bundle.md), so the returned object is
 * the parsed value itself, never a projection of known fields.
 */
export function parseDesignSystemManifest(json: string): DesignSystemManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`design-system.json is not valid JSON: ${(error as Error).message}`)
  }
  if (!isRecord(parsed)) {
    throw new Error('design-system.json: top level must be an object')
  }

  const { schemaVersion, name, version, summary, modes } = parsed
  if (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 1) {
    throw new Error('design-system.json: "schemaVersion" must be a positive integer')
  }
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new Error('design-system.json: "name" must be a non-empty kebab-case string')
  }
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new Error('design-system.json: "version" must be a semver string')
  }
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new Error('design-system.json: "summary" must be a non-empty string')
  }
  if (!isStringArray(modes) || !modes.includes('light') || !modes.includes('dark')) {
    throw new Error('design-system.json: "modes" must be a string array including "light" and "dark"')
  }
  requireStringMap(parsed.namingGrammar, 'namingGrammar')

  const contents = parsed.contents
  if (!isRecord(contents)) {
    throw new Error('design-system.json: "contents" must be an object')
  }
  for (const key of ['foundations', 'components', 'patterns', 'glyphs', 'assets']) {
    if (!isStringArray(contents[key])) {
      throw new Error(`design-system.json: "contents.${key}" must be an array of strings`)
    }
  }

  if (parsed.derived !== undefined) {
    requireStringMap(parsed.derived, 'derived')
  } else {
    parsed.derived = {}
  }
  if (!isRecord(parsed.provenance)) {
    throw new Error('design-system.json: "provenance" must be an object')
  }

  return parsed as DesignSystemManifest
}
