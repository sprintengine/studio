import { createRequire } from 'node:module'

import type { ModuleFileDigests, ModuleResolutionErrorCode } from '../../shared/modules/manifest'
import type { CapabilityModule, MainModuleLoadError, MainModuleLoadReport } from '../module-host/load-modules'
import type { MainHost } from '../module-host/main-host'
import { resolveContainedEntry, sanitizeEntryMessage } from './entry-containment'
import { isLoadEligible, moduleFileDigestIssuesSync } from './module-signature'
import type { InstalledModule, ModuleRejection } from './user-module-registry'

type ThirdPartyMainLoadDiagnostics = {
  rejected: ModuleRejection[]
}

export type ThirdPartyMainLoadInput = {
  modules: InstalledModule[]
  rejected: ModuleRejection[]
}

export type ThirdPartyMainLoadPlan = {
  modules: CapabilityModule[]
  /** Install folder per module id — what contains its entries and its skills. */
  moduleRoots: Record<string, string>
  /** The file digests each trusted module was verified with — what `getAssetPath` resolves against. */
  verifiedFiles: Record<string, ModuleFileDigests>
  ineligible: Record<string, ModuleResolutionErrorCode>
  launchErrors: MainModuleLoadError[]
  diagnostics: ThirdPartyMainLoadDiagnostics
}

type ThirdPartyMainExport = {
  registerMain?: unknown
  default?: unknown
}

export type ThirdPartyMainLaunchSnapshot = {
  loaded: ReadonlySet<string>
  manifestOnly: ReadonlySet<string>
  errors: ReadonlyMap<string, string>
}

let launchSnapshot: ThirdPartyMainLaunchSnapshot = {
  loaded: new Set(),
  manifestOnly: new Set(),
  errors: new Map(),
}

/** Why a module's main half did not run here; Settings shows it in these words. */
export const NEEDS_ELECTRON_MAIN = 'skipped: needs electron-main'

/** `require('electron')` from a module's main half, where its main half runs without Electron. */
export class ElectronUnavailableError extends Error {
  constructor(request: string) {
    super(
      `${NEEDS_ELECTRON_MAIN}: this module's main half requires "${request}", which the Studio server ` +
        'does not provide. Declare requires.hostCapabilities ["electron-main"] in its manifest.',
    )
    this.name = 'ElectronUnavailableError'
  }
}

export function planThirdPartyMainModules(
  input: ThirdPartyMainLoadInput,
  options: {
    /**
     * Whether `electron` can be required where the main halves run: false in
     * the Studio server out of process (owner default 2026-10-01), where a
     * module that declares it needs Electron is loaded manifest-only.
     */
    electronMain?: boolean
  } = {},
): ThirdPartyMainLoadPlan {
  const modules: CapabilityModule[] = []
  const moduleRoots: Record<string, string> = {}
  const verifiedFiles: Record<string, ModuleFileDigests> = {}
  const ineligible: Record<string, ModuleResolutionErrorCode> = {}
  const electronMain = options.electronMain ?? true

  for (const installed of input.modules) {
    const needsElectron = installed.manifest.requires?.hostCapabilities?.includes('electron-main') === true
    modules.push(
      !electronMain && needsElectron
        ? { manifest: installed.manifest }
        : createThirdPartyMainModule(installed, { electronMain }),
    )
    if (!electronMain && needsElectron) skippedForElectron.add(installed.manifest.id)
    moduleRoots[installed.manifest.id] = installed.moduleRoot
    if (isLoadEligible(installed.trust.status) && installed.trust.verifiedFiles) {
      verifiedFiles[installed.manifest.id] = installed.trust.verifiedFiles
    }
    if (isLoadEligible(installed.trust.status)) continue
    ineligible[installed.manifest.id] = installed.trust.status === 'invalid' ? 'invalid_signature' : 'untrusted'
  }

  return {
    modules,
    moduleRoots,
    verifiedFiles,
    ineligible,
    launchErrors: input.rejected.map(rejectionToLoadError),
    diagnostics: { rejected: input.rejected },
  }
}

export function recordThirdPartyMainLaunchReport(moduleIds: readonly string[], report: MainModuleLoadReport): void {
  const thirdPartyIds = new Set(moduleIds)
  launchSnapshot = {
    loaded: new Set(report.loaded.filter((id) => thirdPartyIds.has(id))),
    manifestOnly: new Set(report.manifestOnly.filter((id) => thirdPartyIds.has(id))),
    errors: new Map(
      report.errors
        .filter((error) => thirdPartyIds.has(error.id))
        .map((error) => [error.id, sanitizeLaunchMessage(error.message)]),
    ),
  }
}

export function readThirdPartyMainLaunchSnapshot(): ThirdPartyMainLaunchSnapshot {
  return launchSnapshot
}

/**
 * What this session's main halves did, in the shape that crosses the shell ↔
 * server control channel: out of process the modules load in the server, so
 * the shell's own snapshot is empty and Settings asks the server for its one.
 * `mcpTools` is what each loaded module registered on the gateway.
 */
export type ThirdPartyLaunchSessionWire = {
  loaded: string[]
  errors: Array<[id: string, message: string]>
  mcpTools: Array<{ moduleId: string; name: string }>
}

export type ThirdPartyLaunchSession = {
  snapshot: ThirdPartyMainLaunchSnapshot
  mcpTools: ReadonlyMap<string, string[]>
}

export function encodeThirdPartyLaunchSession(
  snapshot: ThirdPartyMainLaunchSnapshot,
  mcpTools: ReadonlyArray<{ moduleId: string; registration: { name: string } }>,
): ThirdPartyLaunchSessionWire {
  return {
    loaded: [...snapshot.loaded],
    errors: [...snapshot.errors],
    mcpTools: mcpTools.map((tool) => ({ moduleId: tool.moduleId, name: tool.registration.name })),
  }
}

export function decodeThirdPartyLaunchSession(wire: unknown): ThirdPartyLaunchSession {
  const value = (wire ?? {}) as Partial<ThirdPartyLaunchSessionWire>
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  const errors = Array.isArray(value.errors)
    ? value.errors.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string',
      )
    : []
  const mcpTools = new Map<string, string[]>()
  for (const tool of Array.isArray(value.mcpTools) ? value.mcpTools : []) {
    if (!tool || typeof tool.moduleId !== 'string' || typeof tool.name !== 'string') continue
    mcpTools.set(tool.moduleId, [...(mcpTools.get(tool.moduleId) ?? []), tool.name])
  }
  return {
    snapshot: { loaded: new Set(strings(value.loaded)), manifestOnly: new Set(), errors: new Map(errors) },
    mcpTools,
  }
}

function rejectionToLoadError(rejection: ModuleRejection): MainModuleLoadError {
  return {
    id: rejection.path,
    message: rejection.issues.map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`).join('; '),
  }
}

function sanitizeLaunchMessage(message: string): string {
  return sanitizeEntryMessage(message, 'Module main entry failed during startup.')
}

// The modules this process loaded manifest-only because they need Electron.
const skippedForElectron = new Set<string>()

/** Whether a module's main half was skipped here because it needs Electron. */
export function skippedForElectronMain(moduleId: string): boolean {
  return skippedForElectron.has(moduleId)
}

function createThirdPartyMainModule(installed: InstalledModule, options: { electronMain: boolean }): CapabilityModule {
  const entryMain = installed.manifest.entry?.main
  if (!isLoadEligible(installed.trust.status) || !entryMain) {
    return { manifest: installed.manifest }
  }

  const verifiedFiles = installed.trust.verifiedFiles
  return {
    manifest: installed.manifest,
    registerMain: (host) => {
      if (options.electronMain) return loadTrustedEntry(installed.moduleRoot, entryMain, verifiedFiles, host)
      // An undeclared `require('electron')` is caught as it happens (the
      // Studio server's require guard throws ElectronUnavailableError), and
      // classified by name rather than reported as a crash.
      const classify = (error: unknown): never => {
        if (error instanceof Error && error.name === 'ElectronUnavailableError') {
          skippedForElectron.add(installed.manifest.id)
        }
        throw error
      }
      try {
        const registered = loadTrustedEntry(installed.moduleRoot, entryMain, verifiedFiles, host)
        return registered ? Promise.resolve(registered).catch(classify) : registered
      } catch (error) {
        return classify(error)
      }
    },
  }
}

// Trust was decided over the files as discovery found them, and registerMain
// runs later. The whole module folder is held to those digests again here,
// synchronously and immediately before require(), so a file swapped in between
// — the entry or anything it loads from its own folder — is refused rather
// than run. require() reads the entry from disk once more after this check;
// loading from the very bytes hashed would mean compiling through Node's
// private module internals, so the window left is the one between this
// synchronous check and require's own read, in the same tick.
function loadTrustedEntry(
  moduleRoot: string,
  entryMain: string,
  verifiedFiles: ModuleFileDigests | undefined,
  host: MainHost,
): void | Promise<void> {
  const entryPath = resolveContainedEntry(moduleRoot, entryMain, 'entry.main')
  if (!verifiedFiles || verifiedFiles[entryMain] === undefined) {
    throw new Error('entry.main is not among the module files that were verified.')
  }
  const changed = moduleFileDigestIssuesSync(moduleRoot, verifiedFiles, { label: 'digests verified at discovery' })
  if (changed.length > 0) {
    throw new Error(
      `Module files changed after they were verified, so entry.main was not loaded: ${changed
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    )
  }
  const entryModule = createRequire(`${entryPath}.loader.cjs`)(entryPath) as ThirdPartyMainExport
  const registerMain = resolveRegisterMain(entryModule)
  // Returned, not dropped: an async registerMain's promise is what the loader
  // races against its timeout.
  return registerMain(host)
}

function resolveRegisterMain(entryModule: ThirdPartyMainExport): (host: MainHost) => void | Promise<void> {
  if (typeof entryModule.registerMain === 'function') {
    return entryModule.registerMain as (host: MainHost) => void | Promise<void>
  }
  if (
    entryModule.default &&
    typeof entryModule.default === 'object' &&
    typeof (entryModule.default as { registerMain?: unknown }).registerMain === 'function'
  ) {
    return (entryModule.default as { registerMain: (host: MainHost) => void | Promise<void> }).registerMain
  }
  throw new Error('entry.main must export a callable registerMain(host).')
}
