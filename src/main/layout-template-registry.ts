import { cp, mkdir, readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import {
  parseLayoutTemplateManifest,
  type LayoutTemplateManifest,
  type LayoutTemplateRejection,
} from '../shared/layouts/template-manifest'

// User-global layout-template registry: third-party workspace layouts the user
// installs once. Each template is a single <root>/<id>.json file (a FlexLayout
// model + display metadata). This module owns validation and install (Tier 1:
// reject malformed manifests, copy nothing executable).

export type { LayoutTemplateInstallResult, UserLayoutTemplateListResult } from '../shared/layouts/template-manifest'

export function defaultUserLayoutTemplateRoot(): string {
  return join(homedir(), '.multicode', 'layout-templates')
}

async function readDirSafe(dir: string): Promise<import('fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function isJsonFile(name: string): boolean {
  return name.toLowerCase().endsWith('.json')
}

// Top-level *.json files in the selected folder are candidate templates.
export async function resolveTemplateFiles(srcDir: string): Promise<string[]> {
  return (await readDirSafe(srcDir))
    .filter((entry) => !entry.isDirectory() && isJsonFile(entry.name))
    .map((entry) => join(srcDir, entry.name))
}

// Validate and copy a folder's layout-template manifests into the user-global
// root. Malformed manifests are rejected (not copied).
export async function installLayoutTemplateFolder(
  srcDir: string,
  root: string
): Promise<import('../shared/layouts/template-manifest').LayoutTemplateInstallResult> {
  const files = await resolveTemplateFiles(srcDir)
  if (files.length === 0) {
    return {
      ok: false,
      installed: [],
      rejected: [],
      message: 'No layout template JSON files found in the selected folder.',
    }
  }

  const installed: string[] = []
  const rejected: LayoutTemplateRejection[] = []

  for (const file of files) {
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch (error) {
      rejected.push({
        path: file,
        issues: [{ path: '', message: error instanceof Error ? error.message : 'read failed' }],
      })
      continue
    }
    const result = parseLayoutTemplateManifest(source)
    if (!result.ok) {
      rejected.push({ path: file, issues: result.issues })
      continue
    }
    await mkdir(root, { recursive: true })
    // Name on disk by validated id so re-installing an updated template replaces
    // it deterministically rather than accumulating duplicate filenames.
    await cp(file, join(root, `${result.manifest.id}.json`))
    installed.push(result.manifest.id)
  }

  return { ok: installed.length > 0, installed, rejected }
}

// List the layout templates currently installed in the user-global root, with
// malformed ones surfaced so the user can fix them.
export async function loadUserLayoutTemplates(
  root: string
): Promise<import('../shared/layouts/template-manifest').UserLayoutTemplateListResult> {
  const templates: LayoutTemplateManifest[] = []
  const rejected: LayoutTemplateRejection[] = []

  for (const entry of await readDirSafe(root)) {
    if (entry.isDirectory() || !isJsonFile(entry.name)) continue
    const path = join(root, entry.name)
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      rejected.push({ path, issues: [{ path: '', message: error instanceof Error ? error.message : 'read failed' }] })
      continue
    }
    const result = parseLayoutTemplateManifest(source)
    if (!result.ok) {
      rejected.push({ path, issues: result.issues })
      continue
    }
    templates.push(result.manifest)
  }

  // Stable order by id so the picker doesn't reshuffle between loads.
  templates.sort((a, b) => a.id.localeCompare(b.id))
  return { templates, rejected }
}
