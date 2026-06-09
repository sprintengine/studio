import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'

import type { ModuleResolutionErrorCode } from '../../shared/modules/manifest'
import type { CapabilityModule, MainModuleLoadError, MainModuleLoadReport } from '../module-host/load-modules'
import type { MainHost } from '../module-host/main-host'
import { isLoadEligible } from './module-signature'
import type { InstalledModule, ModuleRejection } from './user-module-registry'

export type ThirdPartyMainLoadDiagnostics = {
  rejected: ModuleRejection[]
}

export type ThirdPartyMainLoadInput = {
  modules: InstalledModule[]
  rejected: ModuleRejection[]
}

export type ThirdPartyMainLoadPlan = {
  modules: CapabilityModule[]
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

export function planThirdPartyMainModules(input: ThirdPartyMainLoadInput): ThirdPartyMainLoadPlan {
  const modules: CapabilityModule[] = []
  const ineligible: Record<string, ModuleResolutionErrorCode> = {}

  for (const installed of input.modules) {
    modules.push(createThirdPartyMainModule(installed))
    if (isLoadEligible(installed.trust.status)) continue
    ineligible[installed.manifest.id] = installed.trust.status === 'invalid' ? 'invalid_signature' : 'untrusted'
  }

  return {
    modules,
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
        .map((error) => [error.id, sanitizeLaunchMessage(error.message)])
    ),
  }
}

export function readThirdPartyMainLaunchSnapshot(): ThirdPartyMainLaunchSnapshot {
  return launchSnapshot
}

function rejectionToLoadError(rejection: ModuleRejection): MainModuleLoadError {
  return {
    id: rejection.path,
    message: rejection.issues
      .map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`)
      .join('; '),
  }
}

function sanitizeLaunchMessage(message: string): string {
  if (containsAbsolutePath(message)) return 'Module main entry failed during startup.'
  return message
}

function containsAbsolutePath(message: string): boolean {
  return /(^|[\s'"])(?:\/[\w.-][^\s'"]*|[A-Za-z]:\\[^\s'"]+)/.test(message)
}

function createThirdPartyMainModule(installed: InstalledModule): CapabilityModule {
  const entryMain = installed.manifest.entry?.main
  if (!isLoadEligible(installed.trust.status) || !entryMain) {
    return { manifest: installed.manifest }
  }

  return {
    manifest: installed.manifest,
    registerMain: (host) => {
      loadTrustedEntry(installed.moduleRoot, entryMain, host)
    },
  }
}

function loadTrustedEntry(moduleRoot: string, entryMain: string, host: MainHost): void {
  const entryPath = resolveContainedEntry(moduleRoot, entryMain)
  const entryModule = createRequire(`${entryPath}.loader.cjs`)(entryPath) as ThirdPartyMainExport
  const registerMain = resolveRegisterMain(entryModule)
  registerMain(host)
}

function resolveContainedEntry(moduleRoot: string, entryMain: string): string {
  const root = resolve(moduleRoot)
  const entryPath = resolve(root, entryMain)
  const rootRelative = relative(root, entryPath)
  if (
    rootRelative.length === 0 ||
    rootRelative.startsWith('..') ||
    rootRelative.includes('\0') ||
    resolve(root, rootRelative) !== entryPath
  ) {
    throw new Error('entry.main must resolve inside the module root.')
  }
  return entryPath
}

function resolveRegisterMain(entryModule: ThirdPartyMainExport): (host: MainHost) => void {
  if (typeof entryModule.registerMain === 'function') {
    return entryModule.registerMain as (host: MainHost) => void
  }
  if (
    entryModule.default &&
    typeof entryModule.default === 'object' &&
    typeof (entryModule.default as { registerMain?: unknown }).registerMain === 'function'
  ) {
    return (entryModule.default as { registerMain: (host: MainHost) => void }).registerMain
  }
  throw new Error('entry.main must export a callable registerMain(host).')
}
