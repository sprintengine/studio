import { cp, mkdir, readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { BUNDLED_MODULE_IDS, type CapabilityManifest } from '../../shared/modules/manifest'
import { parseThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest'
import { classifyModuleTrust, type ModuleTrust, type ModuleTrustContext } from './module-signature'

// Discovery + install for third-party capability modules under
// ~/.multicode/modules/<id>/manifest.json. Mirrors the BYO-CLI plugin-registry
// pattern. This layer validates, classifies trust, and installs — it does NOT
// execute module code (in-process loading of trusted modules is a later Phase 7
// increment).

export function defaultUserModuleRoot(): string {
  return join(homedir(), '.multicode', 'modules')
}

export type ModuleRejectionIssue = { path: string; message: string }
export type ModuleRejection = { path: string; issues: ModuleRejectionIssue[] }

export type InstalledModule = {
  manifest: CapabilityManifest
  moduleRoot: string
  trust: ModuleTrust
}

export type UserModuleListResult = {
  modules: InstalledModule[]
  rejected: ModuleRejection[]
}

export type InstallModuleResult =
  | { ok: true; id: string; trust: ModuleTrust }
  | { ok: false; rejected: ModuleRejection; message: string }

const RESERVED_IDS = new Set(BUNDLED_MODULE_IDS)

async function readDirSafe(dir: string): Promise<import('fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// Validate the manifest.json in a module folder and confirm its declared id
// matches the folder name and isn't a reserved bundled id.
async function loadManifestFromDir(
  moduleRoot: string,
  expectedId: string
): Promise<{ ok: true; manifest: CapabilityManifest } | { ok: false; rejection: ModuleRejection }> {
  const manifestPath = join(moduleRoot, 'manifest.json')
  let source: string
  try {
    source = await readFile(manifestPath, 'utf8')
  } catch (error) {
    return {
      ok: false,
      rejection: {
        path: manifestPath,
        issues: [{ path: '', message: error instanceof Error ? error.message : 'manifest.json not found' }],
      },
    }
  }
  const result = parseThirdPartyModuleManifest(source)
  if (!result.ok) return { ok: false, rejection: { path: manifestPath, issues: result.issues } }

  if (RESERVED_IDS.has(result.manifest.id)) {
    return {
      ok: false,
      rejection: {
        path: manifestPath,
        issues: [{ path: 'id', message: `"${result.manifest.id}" is a reserved built-in module id.` }],
      },
    }
  }
  if (result.manifest.id !== expectedId) {
    return {
      ok: false,
      rejection: {
        path: manifestPath,
        issues: [
          { path: 'id', message: `manifest id "${result.manifest.id}" must match its folder name "${expectedId}".` },
        ],
      },
    }
  }
  return { ok: true, manifest: result.manifest }
}

// Enumerate installed third-party modules, validating + trust-classifying each.
export async function discoverUserModules(root: string, ctx: ModuleTrustContext): Promise<UserModuleListResult> {
  const modules: InstalledModule[] = []
  const rejected: ModuleRejection[] = []

  for (const entry of await readDirSafe(root)) {
    if (!entry.isDirectory()) continue
    const moduleRoot = join(root, entry.name)
    const loaded = await loadManifestFromDir(moduleRoot, entry.name)
    if (!loaded.ok) {
      rejected.push(loaded.rejection)
      continue
    }
    modules.push({ manifest: loaded.manifest, moduleRoot, trust: classifyModuleTrust(loaded.manifest, ctx) })
  }

  modules.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  return { modules, rejected }
}

// Validate the manifest in a selected folder, then copy the whole folder into
// the user module root under its declared id (overwriting an existing install of
// the same id). Returns the trust classification so the UI can prompt.
export async function installModuleFolder(
  srcDir: string,
  root: string,
  ctx: ModuleTrustContext
): Promise<InstallModuleResult> {
  // The folder name a manifest must match is its own id, so validate against the
  // manifest's declared id rather than the (arbitrary) source folder name.
  const manifestPath = join(srcDir, 'manifest.json')
  let source: string
  try {
    source = await readFile(manifestPath, 'utf8')
  } catch (error) {
    const rejection = {
      path: manifestPath,
      issues: [{ path: '', message: error instanceof Error ? error.message : 'manifest.json not found' }],
    }
    return { ok: false, rejected: rejection, message: 'No manifest.json found in the selected folder.' }
  }
  const result = parseThirdPartyModuleManifest(source)
  if (!result.ok) {
    return {
      ok: false,
      rejected: { path: manifestPath, issues: result.issues },
      message: 'Module manifest is invalid.',
    }
  }
  if (RESERVED_IDS.has(result.manifest.id)) {
    return {
      ok: false,
      rejected: {
        path: manifestPath,
        issues: [{ path: 'id', message: `"${result.manifest.id}" is a reserved built-in module id.` }],
      },
      message: `"${result.manifest.id}" is a reserved built-in module id.`,
    }
  }

  const destination = join(root, result.manifest.id)
  await mkdir(root, { recursive: true })
  // Copy the folder by content; force overwrites a prior install of this id.
  await cp(srcDir, destination, { recursive: true, force: true })

  return { ok: true, id: result.manifest.id, trust: classifyModuleTrust(result.manifest, ctx) }
}

// Exported for tests / callers that need the install destination of an id.
export function moduleInstallPath(root: string, id: string): string {
  return join(root, basename(id))
}
