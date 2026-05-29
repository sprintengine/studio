import { app, type IpcMain } from 'electron'

import type {
  ThirdPartyModuleInstallResult,
  ThirdPartyModuleListResult,
  ThirdPartyModuleTrustResult,
} from '../../shared/modules/manifest'
import { manifestFingerprint, type ModuleTrustContext } from '../modules/module-signature'
import {
  defaultUserModuleRoot,
  discoverUserModules,
  installModuleFolder,
} from '../modules/user-module-registry'
import { readTrustedModulesSync, setModuleTrust } from '../modules/trust-store'

// Kernel-level IPC for the third-party module registry (Tier 2 trust
// foundation). Pure filesystem + crypto verification — it installs, validates,
// trust-classifies, and records trust. It does NOT execute module code; in-process
// loading of trusted modules is a later Phase 7 increment.
export function registerThirdPartyModuleIpc(ipcMain: IpcMain): void {
  const trustContext = (): ModuleTrustContext => ({
    trustedModules: readTrustedModulesSync(app.getPath('userData')),
  })

  ipcMain.handle('modules:third-party:list', async (): Promise<ThirdPartyModuleListResult> => {
    const { modules, rejected } = await discoverUserModules(defaultUserModuleRoot(), trustContext())
    return {
      modules: modules.map((module) => ({
        manifest: module.manifest,
        trust: module.trust.status,
        fingerprint: module.trust.fingerprint,
      })),
      rejected,
    }
  })

  ipcMain.handle(
    'modules:third-party:install-folder',
    async (_event, srcDir: unknown): Promise<ThirdPartyModuleInstallResult> => {
      if (typeof srcDir !== 'string' || srcDir.trim().length === 0) {
        return { ok: false, message: 'No folder selected.' }
      }
      const result = await installModuleFolder(srcDir, defaultUserModuleRoot(), trustContext())
      if (!result.ok) return { ok: false, message: result.message, issues: result.rejected.issues }
      return { ok: true, id: result.id, trust: result.trust.status }
    }
  )

  ipcMain.handle(
    'modules:third-party:set-trust',
    async (_event, payload: unknown): Promise<ThirdPartyModuleTrustResult> => {
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
        return { ok: false, message: `Module "${id}" has an invalid signature and cannot be trusted.` }
      }
      const { result } = await setModuleTrust(userData, id, manifestFingerprint(target.manifest))
      return { ok: result.ok, message: result.message }
    }
  )
}
