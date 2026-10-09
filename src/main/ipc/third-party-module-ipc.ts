import { lstat, realpath, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import { app, type IpcMain, type IpcMainInvokeEvent } from 'electron'

import type { ThirdPartyModuleUninstallResult } from '../../shared/electron-api'
import { checkHostApiCompatibility } from '../../shared/modules/host-api'
import type {
  ModuleEnablementOverrides,
  ThirdPartyModuleLaunchView,
  ThirdPartyModuleInstallResult,
  ThirdPartyModuleListResult,
  ThirdPartyModuleOrigin,
  ThirdPartyModuleTrustResult,
  ThirdPartyModuleView,
} from '../../shared/modules/manifest'
import { isRecord } from '../../shared/records'
import { readModuleOverridesSync } from '../module-host/enablement-store'
import { forgetModules, isModuleIdSegment } from '../modules/forget-modules'
import { computeHostApiIneligible } from '../modules/host-api-gate'
import { manifestFingerprint, type ModuleTrustContext } from '../modules/module-signature'
import {
  defaultMarketplacePluginInstallStorePath,
  readMarketplacePluginInstallReceipts,
  type MarketplacePluginInstallReceipt,
} from '../marketplace/plugin-lifecycle'
import { listKnownWorkspaceRoots } from '../workspace-roots'
import { assertAppSender } from './ipc-sender'
import {
  createMarketplacePluginPipeline,
  installEnvelope,
  type MarketplacePluginIpcServices,
} from './marketplace-plugin-ipc'
import {
  readThirdPartyMainLaunchSnapshot,
  type ThirdPartyLaunchSession,
  type ThirdPartyMainLaunchSnapshot,
} from '../modules/third-party-main-loader'
import { rendererEntryView } from '../modules/third-party-renderer-entries'
import {
  defaultUserModuleRoot,
  discoverUserModules,
  type InstalledModule,
  installModuleFolder,
} from '../modules/user-module-registry'
import { readModuleTrustContextSync } from '../modules/trust-context'
import { setModuleTrust } from '../modules/trust-store'
import { notifyRendererModulesChanged } from '../modules/notify-renderer-modules-changed'

// Kernel-level IPC for the third-party module registry (Tier 2 trust
// foundation). Pure filesystem + crypto verification — it installs, validates,
// trust-classifies, and records trust. Startup execution is owned by the
// trusted third-party main loader; this IPC only reports launch readiness.
export function registerThirdPartyModuleIpc(
  ipcMain: IpcMain,
  // What uninstalling a marketplace or GitHub install needs: the lifecycle's
  // MCP and automation services, and the open workspaces an MCP or skill
  // removal may write into.
  services: MarketplacePluginIpcServices,
  options: {
    /**
     * What this session's main halves did. In process that is this process's
     * own launch snapshot; out of process the modules load in the server and
     * the shell asks it. The default reads the local snapshot and knows no
     * MCP tools.
     */
    readLaunchSession?: () => Promise<ThirdPartyLaunchSession>
  } = {},
): void {
  const trustContext = (): ModuleTrustContext => readModuleTrustContextSync(app.getPath('userData'))
  let pipeline: ReturnType<typeof createMarketplacePluginPipeline> | null = null
  const marketplace = () => (pipeline ??= createMarketplacePluginPipeline(services))

  const readLaunchSession = async (): Promise<ThirdPartyLaunchSession> => {
    const local = { snapshot: readThirdPartyMainLaunchSnapshot(), mcpTools: new Map<string, string[]>() }
    if (!options.readLaunchSession) return local
    try {
      return await options.readLaunchSession()
    } catch {
      // A server that is restarting answers nothing; the list still answers.
      return local
    }
  }

  ipcMain.handle('modules:third-party:list', async (): Promise<ThirdPartyModuleListResult> => {
    const userData = app.getPath('userData')
    const [{ modules, rejected }, session, receipts] = await Promise.all([
      discoverUserModules(defaultUserModuleRoot(), trustContext()),
      readLaunchSession(),
      readMarketplacePluginInstallReceipts(defaultMarketplacePluginInstallStorePath(userData)),
    ])
    const enablementOverrides = readModuleOverridesSync(userData)
    // An unreadable receipt store leaves origins unknown rather than calling
    // every module a folder install.
    const origins = receipts.ok ? moduleOriginsFromReceipts(receipts.receipts) : null
    return {
      modules: modules.map((module) =>
        toThirdPartyModuleView(module, session.snapshot, enablementOverrides, {
          ...(origins ? { origin: origins.get(module.manifest.id) ?? { kind: 'folder' } } : {}),
          mcpTools: session.mcpTools.get(module.manifest.id) ?? [],
        }),
      ),
      rejected,
    }
  })

  // Uninstall, whichever way the module arrived. A module a marketplace or
  // GitHub install put in place belongs to its receipt, and the whole bundle
  // comes out through the lifecycle — its MCP servers and skill copies too, and
  // the receipt with them. A module dropped in from a folder has no receipt:
  // its folder is removed, and only after checking it is exactly one folder
  // directly under the module root, so no id can reach anything else. Either
  // way nothing about it outlives it — trust grant, enablement choice, stored
  // secrets — so a later module that takes the same id starts from nothing.
  ipcMain.handle(
    'modules:third-party:uninstall',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<ThirdPartyModuleUninstallResult> => {
      try {
        assertAppSender(event)
        const id = isRecord(input) && typeof input.id === 'string' ? input.id.trim() : ''
        if (!isModuleIdSegment(id)) return { ok: false, message: 'A module id is required.' }
        const userData = app.getPath('userData')

        const receipts = await readMarketplacePluginInstallReceipts(defaultMarketplacePluginInstallStorePath(userData))
        if (!receipts.ok) return { ok: false, message: receipts.message }
        const receipt = receipts.receipts.find(
          (candidate) =>
            candidate.id === id ||
            candidate.components.some((component) => component.kind === 'module' && component.id === id),
        )

        let removedModuleIds: string[]
        if (receipt) {
          const envelope = installEnvelope(
            input as Record<string, unknown>,
            listKnownWorkspaceRoots(services.workspaceSyncService.getSnapshot()),
          )
          if (!envelope.ok) return { ok: false, message: envelope.message }
          const result = await marketplace().lifecycle.uninstall({ ...envelope.value, pluginId: receipt.id })
          if (!result.ok) return { ok: false, message: result.message }
          removedModuleIds = result.removed
            .filter((component) => component.kind === 'module')
            .map((component) => component.id)
          notifyRendererModulesChanged()
          await forgetModules(userData, removedModuleIds)
          return {
            ok: true,
            removedModuleIds,
            ...(result.mcpSettings ? { mcpSettings: result.mcpSettings } : {}),
          }
        }

        const { modules } = await discoverUserModules(defaultUserModuleRoot(), trustContext())
        const target = modules.find((module) => module.manifest.id === id)
        if (!target) return { ok: false, message: `Module "${id}" is not installed.` }
        const contained = await containedModuleFolder(defaultUserModuleRoot(), target.moduleRoot)
        if (!contained.ok) return { ok: false, message: contained.message }
        await rm(contained.path, { recursive: true, force: true })
        const { result: revoked } = await setModuleTrust(userData, id, null)
        notifyRendererModulesChanged()
        await forgetModules(userData, [id])
        if (!revoked.ok) {
          return {
            ok: false,
            message: `Removed "${id}" but could not withdraw its trust: ${revoked.message ?? 'unknown error'}`,
          }
        }
        return { ok: true, removedModuleIds: [id] }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'modules:third-party:install-folder',
    async (event: IpcMainInvokeEvent, srcDir: unknown): Promise<ThirdPartyModuleInstallResult> => {
      // Installing and trusting change what runs on this machine, as
      // uninstalling does: they answer only the app's own window.
      assertAppSender(event)
      if (typeof srcDir !== 'string' || srcDir.trim().length === 0) {
        return { ok: false, message: 'No folder selected.' }
      }
      const result = await installModuleFolder(srcDir, defaultUserModuleRoot(), trustContext())
      if (!result.ok) return { ok: false, message: result.message, issues: result.rejected.issues }
      notifyRendererModulesChanged()
      return { ok: true, id: result.id, trust: result.trust.status }
    },
  )

  ipcMain.handle(
    'modules:third-party:set-trust',
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<ThirdPartyModuleTrustResult> => {
      assertAppSender(event)
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof (payload as { id?: unknown }).id !== 'string' ||
        typeof (payload as { trusted?: unknown }).trusted !== 'boolean'
      ) {
        return { ok: false, message: 'Invalid trust request.' }
      }
      const { id, trusted } = payload as { id: string; trusted: boolean }
      const userData = app.getPath('userData')

      if (!trusted) {
        const { result } = await setModuleTrust(userData, id, null)
        return { ok: result.ok, message: result.message }
      }

      // Bind trust to the *currently installed* manifest's fingerprint. Re-discover
      // so we trust exactly what's on disk now (not a stale renderer value).
      const { modules } = await discoverUserModules(defaultUserModuleRoot(), trustContext())
      const target = modules.find((module) => module.manifest.id === id)
      if (!target) return { ok: false, message: `Module "${id}" is not installed.` }
      if (target.trust.status === 'invalid') {
        return {
          ok: false,
          message: target.trust.tampered
            ? `Module "${id}" does not match the file digests its manifest signs and cannot be trusted.`
            : `Module "${id}" has an invalid signature and cannot be trusted.`,
        }
      }
      // The grant covers the code as well as the manifest: it binds to the
      // manifest fingerprint, which covers the `files` digests the folder was
      // just held to (a mismatch is 'invalid', refused above). A manifest
      // without them gives a grant nothing to bind the code to.
      if (!target.manifest.files) {
        return {
          ok: false,
          message:
            `Module "${id}" lists no digests of its code, so trusting it could not cover what runs. ` +
            'Sign it with `sprintengine-module sign`, which records them, and install it again.',
        }
      }
      const { result } = await setModuleTrust(userData, id, manifestFingerprint(target.manifest))
      if (result.ok) notifyRendererModulesChanged()
      return { ok: result.ok, message: result.message }
    },
  )
}

// The folder an uninstall may remove: a real directory (not a link to one)
// whose parent is the module root itself, both taken through realpath so a
// symlinked root or folder cannot move the target somewhere else.
async function containedModuleFolder(
  moduleRoot: string,
  folder: string,
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const refused = {
    ok: false as const,
    message: 'That module’s folder is not inside the modules folder, so it was left alone.',
  }
  try {
    const info = await lstat(folder)
    if (!info.isDirectory() || info.isSymbolicLink()) return refused
    const [root, real] = await Promise.all([realpath(moduleRoot), realpath(folder)])
    if (dirname(real) !== root || basename(real) === '') return refused
    return { ok: true, path: real }
  } catch {
    return refused
  }
}

// Each module a receipt put in place, by module id, with where the receipt's
// bundle came from. A receipt without a source predates the field and was
// always the registry.
export function moduleOriginsFromReceipts(
  receipts: readonly MarketplacePluginInstallReceipt[],
): Map<string, ThirdPartyModuleOrigin> {
  const origins = new Map<string, ThirdPartyModuleOrigin>()
  for (const receipt of receipts) {
    const origin: ThirdPartyModuleOrigin =
      receipt.source?.kind === 'github'
        ? { kind: 'github', pluginId: receipt.id, repo: `${receipt.source.owner}/${receipt.source.repo}` }
        : { kind: 'marketplace', pluginId: receipt.id }
    for (const component of receipt.components) {
      if (component.kind === 'module') origins.set(component.id, origin)
    }
  }
  return origins
}

export function toThirdPartyModuleView(
  module: InstalledModule,
  launchSnapshot: ThirdPartyMainLaunchSnapshot = readThirdPartyMainLaunchSnapshot(),
  enablementOverrides: ModuleEnablementOverrides = {},
  extras: Pick<ThirdPartyModuleView, 'origin' | 'mcpTools'> = {},
): ThirdPartyModuleView {
  return {
    manifest: module.manifest,
    trust: module.trust.status,
    fingerprint: module.trust.fingerprint,
    launch: launchViewFor(module, launchSnapshot, enablementOverrides),
    ...(module.trust.status === 'trusted' && module.trust.via ? { trustedVia: module.trust.via } : {}),
    ...extras,
  }
}

function launchViewFor(
  module: InstalledModule,
  launchSnapshot: ThirdPartyMainLaunchSnapshot,
  enablementOverrides: ModuleEnablementOverrides,
): ThirdPartyModuleLaunchView {
  return {
    ...mainEntryLaunchView(module, launchSnapshot, enablementOverrides),
    mainLoaded: launchSnapshot.loaded.has(module.manifest.id),
    rendererEntry: rendererEntryView(module),
  }
}

function mainEntryLaunchView(
  module: InstalledModule,
  launchSnapshot: ThirdPartyMainLaunchSnapshot,
  enablementOverrides: ModuleEnablementOverrides,
): ThirdPartyModuleLaunchView {
  const id = module.manifest.id
  const hasMainEntry = Boolean(module.manifest.entry?.main)
  // Built for a host API this app does not provide: neither entry loads, and
  // trusting it would not change that, so it says so ahead of any trust
  // state. A tampered module keeps its own, louder, reason (host-api-gate.ts).
  if (module.trust.status !== 'invalid' && computeHostApiIneligible([module])[id]) {
    const compatibility = checkHostApiCompatibility(module.manifest)
    return {
      status: 'blocked_host_api',
      hasMainEntry,
      expectedToLoad: false,
      message: compatibility.ok ? 'Built for another host API.' : compatibility.message,
    }
  }
  if (module.trust.status === 'invalid') {
    return {
      status: 'blocked_invalid',
      hasMainEntry,
      expectedToLoad: false,
      message: module.trust.tampered
        ? 'Its files do not match the digests its manifest signs (tampered), so it will not run.'
        : 'Invalid signature blocks startup execution.',
    }
  }
  if (module.trust.status === 'signed') {
    return {
      status: 'blocked_signed',
      hasMainEntry,
      expectedToLoad: false,
      message: 'Signed module is waiting for trust before startup execution.',
    }
  }
  if (module.trust.status === 'unsigned') {
    return {
      status: 'blocked_unsigned',
      hasMainEntry,
      expectedToLoad: false,
      message: 'Unsigned module is waiting for trust before startup execution.',
    }
  }

  if (!hasMainEntry) {
    return {
      status: 'trusted_manifest_only',
      hasMainEntry,
      expectedToLoad: false,
      message: 'Trusted manifest-only module; no main entry will run.',
    }
  }

  const launchError = launchSnapshot.errors.get(id)
  if (launchError) {
    return {
      status: 'launch_error',
      hasMainEntry,
      expectedToLoad: false,
      message: launchError,
    }
  }

  const expectedToLoad = enablementOverrides[id] ?? module.manifest.defaultEnabled
  return {
    status: 'trusted_executable',
    hasMainEntry,
    expectedToLoad,
    message: expectedToLoad
      ? 'Trusted main entry is eligible for startup execution.'
      : module.manifest.defaultEnabled
        ? 'Trusted main entry is disabled by user setting until enabled.'
        : 'Trusted main entry is disabled by default until enabled.',
  }
}
