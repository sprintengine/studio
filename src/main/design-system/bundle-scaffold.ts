import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'

import {
  DESIGN_SYSTEM_MANIFEST_FILENAME,
  DESIGN_SYSTEM_SCHEMA_VERSION,
  parseDesignSystemManifest,
} from '../../shared/design-system/manifest'
import {
  DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME,
  type DesignSystemScaffoldResult,
} from '../../shared/design-system/bundle-scaffold'

// Scaffolds the design-system bundle layout for the Design Wizard's
// design-system preset: stamps the governance templates (USAGE.md, AGENTS.md,
// scripts/*.mjs) from resources/design-system/templates verbatim, creates the
// authored-content directories, and writes a fresh manifest. Authored content
// (tokens, principles, components, patterns, glyphs) is the designer agent's
// work — the scaffold never seeds sample design content, so nothing in the
// bundle pretends to be authored. Layout contract:
// knowledge/multicode/design-system-bundle.md.

const AUTHORED_CONTENT_DIRECTORIES = [
  'foundations',
  'components',
  'patterns',
  'glyphs',
  'assets',
  'catalog',
] as const

// v1 naming-grammar prose is part of the schema contract and identical for
// every authored bundle (the reference example carries the same text).
const V1_NAMING_GRAMMAR: Record<string, string> = {
  tokens:
    "<tier>.<group...>.<name> — tier is 'ref' or 'sem'; every segment is lowercase kebab-case; nesting follows DTCG groups; aliases reference the full dotted path as {tier.group.name}",
  cssVariables:
    "'--' plus the token path with '.' replaced by '-' (sem.color.bg.app -> --sem-color-bg-app); components consume only the --sem-* set",
  components:
    'kebab-case directory under components/, containing component.html, component.css, and component.md',
  glyphs: 'kebab-case concept name, one concept per SVG; strokes and fills use currentColor',
}

export function kebabCaseBundleName(value: string): string {
  const name = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return name || DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME
}

function manifestSummary(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (!collapsed) return 'Design system authored in the Multicode Design Wizard.'
  return collapsed.length > 160 ? `${collapsed.slice(0, 159).trimEnd()}…` : collapsed
}

function buildManifestJson(name: string, summary: string): string {
  const manifest = {
    schemaVersion: DESIGN_SYSTEM_SCHEMA_VERSION,
    name,
    version: '0.1.0',
    summary,
    modes: ['light', 'dark'],
    namingGrammar: V1_NAMING_GRAMMAR,
    contents: { foundations: [], components: [], patterns: [], glyphs: [], assets: [] },
    derived: {
      'foundations/tokens.css': 'scripts/build-tokens.mjs',
      'catalog/index.html': 'scripts/build-catalog.mjs',
    },
    provenance: {
      authoredBy: 'multicode-design-wizard',
      sourceLibraryId: null,
      sourceLibraryVersion: null,
      releasedAt: null,
      attachedAt: null,
    },
  }
  const json = `${JSON.stringify(manifest, null, 2)}\n`
  // Self-check against the canonical parser so a scaffold bug fails loudly
  // here instead of surfacing later as an unreadable bundle.
  parseDesignSystemManifest(json)
  return json
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export interface ScaffoldDesignSystemBundleInput {
  /** Workspace root the bundle directory is created under. */
  workspaceRoot: string
  /** Human workspace/system name; kebab-cased into the manifest `name`. */
  name: string
  /** The user's design goal; collapsed into the manifest `summary`. */
  summary: string
  /** Absolute path of resources/design-system/templates (resolved by the caller). */
  templatesDir: string
}

/**
 * Stamp the bundle layout into `<workspaceRoot>/design-system/`. Never
 * overwrites: when a manifest already exists the result reports
 * `alreadyExisted` and leaves the bundle untouched, so reopening an authoring
 * workspace resumes it. Any other failure is returned as `ok: false` with the
 * cause — no partial-success masking.
 */
export async function scaffoldDesignSystemBundle(
  input: ScaffoldDesignSystemBundleInput,
): Promise<DesignSystemScaffoldResult> {
  if (!input.workspaceRoot.trim()) {
    return { ok: false, message: 'No workspace root provided.' }
  }
  const bundleDir = join(input.workspaceRoot, DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME)
  try {
    if (await pathExists(join(bundleDir, DESIGN_SYSTEM_MANIFEST_FILENAME))) {
      return { ok: true, bundleDir, alreadyExisted: true }
    }

    const templateFiles = ['USAGE.md', 'AGENTS.md'] as const
    for (const file of templateFiles) {
      if (!(await pathExists(join(input.templatesDir, file)))) {
        return {
          ok: false,
          message: `Design-system template missing: ${file} (looked in ${input.templatesDir})`,
        }
      }
    }
    const scriptsDir = join(input.templatesDir, 'scripts')
    const scriptNames = (await readdir(scriptsDir).catch(() => [] as string[])).filter((name) =>
      name.endsWith('.mjs'),
    )
    if (scriptNames.length === 0) {
      return {
        ok: false,
        message: `Design-system script templates missing (looked in ${scriptsDir})`,
      }
    }

    await mkdir(bundleDir, { recursive: true })
    for (const directory of AUTHORED_CONTENT_DIRECTORIES) {
      await mkdir(join(bundleDir, directory), { recursive: true })
    }
    for (const file of templateFiles) {
      await copyFile(join(input.templatesDir, file), join(bundleDir, file))
    }
    await mkdir(join(bundleDir, 'scripts'), { recursive: true })
    for (const script of scriptNames.sort()) {
      await copyFile(join(scriptsDir, script), join(bundleDir, 'scripts', script))
    }

    await writeFile(
      join(bundleDir, DESIGN_SYSTEM_MANIFEST_FILENAME),
      buildManifestJson(kebabCaseBundleName(input.name), manifestSummary(input.summary)),
    )
    // Read-back verification: the manifest on disk must parse with the
    // canonical parser before the scaffold reports success.
    parseDesignSystemManifest(await readFile(join(bundleDir, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8'))
    return { ok: true, bundleDir }
  } catch (error) {
    return {
      ok: false,
      message: `Could not scaffold the design-system bundle: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
