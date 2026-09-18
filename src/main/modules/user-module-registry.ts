import { readdirSync, readFileSync } from 'fs'
import { cp, mkdir, readdir, readFile, rename, rm } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { BUNDLED_MODULE_IDS, type CapabilityManifest } from '../../shared/modules/manifest'
import { parseThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest'
import {
  classifyModuleTrust,
  isSignedByTrustedPublisher,
  manifestFingerprint,
  type ModuleTrust,
  type ModuleTrustContext,
} from './module-signature'
import { readStudioEnv } from '../../shared/studio-env'

// Discovery + install for third-party capability modules under
// ~/.multicode/modules/<id>/manifest.json. Mirrors the BYO-CLI plugin-registry
// pattern. This layer validates, classifies trust, and installs — it does NOT
// execute module code; trusted `entry.main` loading is wired separately through
// third-party-main-loader.

// SPRINTENGINE_USER_MODULE_ROOT redirects discovery for hermetic end-to-end
// testing (paired with SPRINTENGINE_USER_DATA_DIR temp profiles). It moves the
// install root only — trust classification, signing, and isLoadEligible gating
// apply to that root exactly as they do to the default one.
export function defaultUserModuleRoot(): string {
  const override = readStudioEnv('SPRINTENGINE_USER_MODULE_ROOT')?.trim()
  if (override) return override
  return join(homedir(), '.multicode', 'modules')
}

type ModuleRejectionIssue = { path: string; message: string }
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
  // `manifestFp` is the fingerprint of the manifest that was just installed —
  // the identity a trust grant binds to, so a later install of different bytes
  // under the same id cannot inherit it (see module-signature.ts).
  | { ok: true; id: string; trust: ModuleTrust; manifestFp: string }
  | { ok: false; rejected: ModuleRejection; message: string }

const RESERVED_IDS = new Set(BUNDLED_MODULE_IDS)

async function readDirSafe(dir: string): Promise<import('fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function readDirSafeSync(dir: string): import('fs').Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// A module id never starts with a dot, so a dotted directory under the module
// root is never a module: it is this file's own install staging folder, or an
// editor's. Skipping it keeps a half-written install out of the rejected list
// (where it would read as a broken module the user cannot find).
function isHiddenModuleDir(name: string): boolean {
  return name.startsWith('.')
}

// Validate the manifest.json in a module folder and confirm its declared id
// matches the folder name and isn't an impermissible reserved id. Reserved
// (bundled) ids are publisher-locked, not absolutely blocked: a module signed
// with a first-party marketplace publisher key may claim one — that's how the
// extracted first-party modules keep their ids (and existing workspace modes)
// while third parties still can't shadow them.
function validateInstalledManifestSource(
  source: string,
  manifestPath: string,
  expectedId: string,
  ctx: ModuleTrustContext,
): { ok: true; manifest: CapabilityManifest } | { ok: false; rejection: ModuleRejection } {
  const result = parseThirdPartyModuleManifest(source)
  if (!result.ok) return { ok: false, rejection: { path: manifestPath, issues: result.issues } }

  if (RESERVED_IDS.has(result.manifest.id) && !isSignedByTrustedPublisher(result.manifest, ctx)) {
    return {
      ok: false,
      rejection: {
        path: manifestPath,
        issues: [
          {
            path: 'id',
            message: `"${result.manifest.id}" is a reserved id, publisher-locked to the first-party signing key.`,
          },
        ],
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

async function loadManifestFromDir(
  moduleRoot: string,
  expectedId: string,
  ctx: ModuleTrustContext,
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
  return validateInstalledManifestSource(source, manifestPath, expectedId, ctx)
}

function loadManifestFromDirSync(
  moduleRoot: string,
  expectedId: string,
  ctx: ModuleTrustContext,
): { ok: true; manifest: CapabilityManifest } | { ok: false; rejection: ModuleRejection } {
  const manifestPath = join(moduleRoot, 'manifest.json')
  let source: string
  try {
    source = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    return {
      ok: false,
      rejection: {
        path: manifestPath,
        issues: [{ path: '', message: error instanceof Error ? error.message : 'manifest.json not found' }],
      },
    }
  }
  return validateInstalledManifestSource(source, manifestPath, expectedId, ctx)
}

// Enumerate installed third-party modules, validating + trust-classifying each.
export async function discoverUserModules(root: string, ctx: ModuleTrustContext): Promise<UserModuleListResult> {
  const modules: InstalledModule[] = []
  const rejected: ModuleRejection[] = []

  for (const entry of await readDirSafe(root)) {
    if (!entry.isDirectory() || isHiddenModuleDir(entry.name)) continue
    const moduleRoot = join(root, entry.name)
    const loaded = await loadManifestFromDir(moduleRoot, entry.name, ctx)
    if (!loaded.ok) {
      rejected.push(loaded.rejection)
      continue
    }
    modules.push({ manifest: loaded.manifest, moduleRoot, trust: classifyModuleTrust(loaded.manifest, ctx) })
  }

  modules.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  return { modules, rejected }
}

export function discoverUserModulesSync(root: string, ctx: ModuleTrustContext): UserModuleListResult {
  const modules: InstalledModule[] = []
  const rejected: ModuleRejection[] = []

  for (const entry of readDirSafeSync(root)) {
    if (!entry.isDirectory() || isHiddenModuleDir(entry.name)) continue
    const moduleRoot = join(root, entry.name)
    const loaded = loadManifestFromDirSync(moduleRoot, entry.name, ctx)
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
// the user module root under its declared id, REPLACING any existing install of
// that id (see the copy below for why replacing and not merging).
// Returns the trust classification so the UI can prompt.
export async function installModuleFolder(
  srcDir: string,
  root: string,
  ctx: ModuleTrustContext,
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
  if (RESERVED_IDS.has(result.manifest.id) && !isSignedByTrustedPublisher(result.manifest, ctx)) {
    const message = `"${result.manifest.id}" is a reserved id, publisher-locked to the first-party signing key.`
    return {
      ok: false,
      rejected: { path: manifestPath, issues: [{ path: 'id', message }] },
      message,
    }
  }

  const destination = join(root, result.manifest.id)
  await mkdir(root, { recursive: true })
  // A re-install REPLACES the folder; it does not merge into it. `cp --force`
  // overwrites every file it is given and leaves every file it is not, so a
  // version that dropped `dist/renderer.mjs` used to install on top of the
  // version that had one — and the stale bundle, still matching the manifest's
  // old entry path, kept loading. The trust grant is bound to the manifest
  // fingerprint, so those leftovers rode in under a fingerprint that never
  // covered them.
  //
  // The copy lands in a temp sibling and is renamed into place, so a copy that
  // fails halfway leaves the previous install standing rather than a folder
  // with half of each version in it. Rename is not atomic across the two steps
  // (the old folder has to go first), so the window is real but small, and the
  // caller's rollback path restores from its own snapshot.
  const staging = join(root, `.${basename(result.manifest.id)}.installing.${process.pid}.${Date.now()}`)
  await rm(staging, { recursive: true, force: true })
  try {
    await cp(srcDir, staging, { recursive: true, force: true })
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      rejected: { path: destination, issues: [{ path: '', message }] },
      message: `Could not install module "${result.manifest.id}": ${message}`,
    }
  }

  return {
    ok: true,
    id: result.manifest.id,
    trust: classifyModuleTrust(result.manifest, ctx),
    manifestFp: manifestFingerprint(result.manifest),
  }
}

// Exported for tests / callers that need the install destination of an id.
export function moduleInstallPath(root: string, id: string): string {
  return join(root, basename(id))
}
