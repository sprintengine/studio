import { readdirSync, readFileSync } from 'fs'
import { cp, mkdir, readdir, readFile, rename, rm } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { BUNDLED_MODULE_IDS, type CapabilityManifest } from '../../shared/modules/manifest'
import { parseThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest'
import {
  classifyModuleTrust,
  isTrustedByPublisher,
  moduleContentFingerprintSync,
  type ModuleTrust,
  type ModuleTrustContext,
} from './module-signature'
import { readStudioEnv } from '../../shared/studio-env'

// Discovery + install for third-party capability modules under
// ~/.sprintengine/modules/<id>/manifest.json. Mirrors the BYO-CLI plugin-registry
// pattern. This layer validates, classifies trust, and installs — it does NOT
// execute module code; trusted `entry.main` loading is wired separately through
// third-party-main-loader. Trust is classified over the folder's files as well
// as its manifest (module-signature.ts), so it is decided again from the bytes
// on disk at every discovery, not carried over from the install.

// SPRINTENGINE_USER_MODULE_ROOT redirects discovery for hermetic end-to-end
// testing (paired with SPRINTENGINE_USER_DATA_DIR temp profiles). It moves the
// install root only — trust classification, signing, and isLoadEligible gating
// apply to that root exactly as they do to the default one.
export function defaultUserModuleRoot(): string {
  const override = readStudioEnv('SPRINTENGINE_USER_MODULE_ROOT')?.trim()
  if (override) return override
  return join(homedir(), '.sprintengine', 'modules')
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
  // `manifestFp` is the fingerprint of what was just installed: the manifest
  // together with the digest of every file it was installed with. For a
  // manifest that lists its `files` this is its manifest fingerprint, the
  // identity a trust grant binds to; for a first-party manifest from before
  // `files`, it is what a verified marketplace install records as vouched for.
  // Either way a later install of different bytes under the same id, code
  // included, cannot inherit it (see moduleContentFingerprint).
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

// Reserved (bundled) ids are publisher-locked, not absolutely blocked: a module
// trusted through a first-party marketplace publisher key may claim one —
// that's how the extracted first-party modules keep their ids (and existing
// workspace modes) while third parties still can't shadow them. Trusted through
// the key means the key vouches for the code too (a signed manifest copied
// next to other code does not), so a reserved id is refused on the same
// classification that decides whether the module loads.
function reservedIdIssues(manifest: CapabilityManifest, trust: ModuleTrust): ModuleRejectionIssue[] {
  if (!RESERVED_IDS.has(manifest.id) || isTrustedByPublisher(trust)) return []
  return [
    {
      path: 'id',
      message: `"${manifest.id}" is a reserved id, publisher-locked to the first-party signing key.`,
    },
    ...(trust.issues ?? []),
  ]
}

// Validate the manifest.json in a module folder and confirm its declared id
// matches the folder name.
function validateInstalledManifestSource(
  source: string,
  manifestPath: string,
  expectedId: string,
): { ok: true; manifest: CapabilityManifest } | { ok: false; rejection: ModuleRejection } {
  const result = parseThirdPartyModuleManifest(source)
  if (!result.ok) return { ok: false, rejection: { path: manifestPath, issues: result.issues } }

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
  return validateInstalledManifestSource(source, manifestPath, expectedId)
}

function loadManifestFromDirSync(
  moduleRoot: string,
  expectedId: string,
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
  return validateInstalledManifestSource(source, manifestPath, expectedId)
}

// Classify a module whose manifest validated, or reject it for claiming a
// reserved id it has not earned.
function classifyInstalled(
  manifest: CapabilityManifest,
  moduleRoot: string,
  ctx: ModuleTrustContext,
): { ok: true; module: InstalledModule } | { ok: false; rejection: ModuleRejection } {
  const trust = classifyModuleTrust(manifest, moduleRoot, ctx)
  const reserved = reservedIdIssues(manifest, trust)
  if (reserved.length > 0) {
    return { ok: false, rejection: { path: join(moduleRoot, 'manifest.json'), issues: reserved } }
  }
  return { ok: true, module: { manifest, moduleRoot, trust } }
}

// Enumerate installed third-party modules, validating + trust-classifying each.
export async function discoverUserModules(root: string, ctx: ModuleTrustContext): Promise<UserModuleListResult> {
  const modules: InstalledModule[] = []
  const rejected: ModuleRejection[] = []

  for (const entry of await readDirSafe(root)) {
    if (!entry.isDirectory() || isHiddenModuleDir(entry.name)) continue
    const moduleRoot = join(root, entry.name)
    const loaded = await loadManifestFromDir(moduleRoot, entry.name)
    const classified = loaded.ok ? classifyInstalled(loaded.manifest, moduleRoot, ctx) : loaded
    if (classified.ok) modules.push(classified.module)
    else rejected.push(classified.rejection)
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
    const loaded = loadManifestFromDirSync(moduleRoot, entry.name)
    const classified = loaded.ok ? classifyInstalled(loaded.manifest, moduleRoot, ctx) : loaded
    if (classified.ok) modules.push(classified.module)
    else rejected.push(classified.rejection)
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
  // Trust is classified over the folder as selected, before anything is
  // copied: code that does not match the digests its manifest signs is refused
  // outright, and so is a folder whose files cannot be digested at all (a
  // symlink, a .git) — nothing could ever trust it, so installing it would only
  // leave a module behind that the user is asked about and cannot approve.
  const sourceTrust = classifyModuleTrust(result.manifest, srcDir, ctx)
  if (sourceTrust.tampered) {
    return {
      ok: false,
      rejected: { path: manifestPath, issues: sourceTrust.issues ?? [] },
      message: `Module "${result.manifest.id}" has been tampered with: its files do not match the digests its manifest signs.`,
    }
  }
  const reserved = reservedIdIssues(result.manifest, sourceTrust)
  if (reserved.length > 0) {
    return {
      ok: false,
      rejected: { path: manifestPath, issues: reserved },
      message: reserved[0]!.message,
    }
  }
  const sourceContent = moduleContentFingerprintSync(result.manifest, srcDir)
  if (!sourceContent.ok) {
    return {
      ok: false,
      rejected: { path: manifestPath, issues: sourceContent.issues },
      message:
        `Module "${result.manifest.id}" has files a module cannot ship. Install the folder ` +
        '`sprintengine-module pack` writes, which leaves out node_modules, .git and key files.',
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
  //
  // The staged copy is classified again before it replaces anything: the
  // result reports the trust of the bytes that were installed, and a copy that
  // differs from the folder just checked never lands.
  const staging = join(root, `.${basename(result.manifest.id)}.installing.${process.pid}.${Date.now()}`)
  await rm(staging, { recursive: true, force: true })
  let trust: ModuleTrust
  try {
    await cp(srcDir, staging, { recursive: true, force: true })
    const staged = moduleContentFingerprintSync(result.manifest, staging)
    if (!staged.ok || staged.fingerprint !== sourceContent.fingerprint) {
      throw new Error('the module folder changed while it was being installed.')
    }
    trust = classifyModuleTrust(result.manifest, staging, ctx)
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
    trust,
    manifestFp: sourceContent.fingerprint,
  }
}

// Exported for tests / callers that need the install destination of an id.
export function moduleInstallPath(root: string, id: string): string {
  return join(root, basename(id))
}
