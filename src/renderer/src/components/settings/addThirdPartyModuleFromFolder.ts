import type { ElectronApi } from '../../../../shared/electron-api'
import type { ModuleTrustStatus } from '../../../../shared/modules/manifest'

type ModuleFolderInstallApi = Pick<ElectronApi, 'openDir' | 'installThirdPartyModuleFolder'>

export type AddThirdPartyModuleOutcome =
  | { status: 'cancelled' }
  | { status: 'installed'; id: string | null; trust: ModuleTrustStatus | null }
  | { status: 'failed'; message: string }

/**
 * The one folder-picker install round trip used by both Settings and the
 * Extensions drawer. Validation, copying, signature classification, and trust
 * remain main-process responsibilities behind `installThirdPartyModuleFolder`;
 * this adapter only turns cancellation and transport failures into UI states.
 */
export async function addThirdPartyModuleFromFolder(
  api: Partial<ModuleFolderInstallApi>,
): Promise<AddThirdPartyModuleOutcome> {
  if (typeof api.openDir !== 'function' || typeof api.installThirdPartyModuleFolder !== 'function') {
    return { status: 'failed', message: 'Installing extension modules is unavailable in this build.' }
  }

  try {
    const folder = await api.openDir()
    if (!folder) return { status: 'cancelled' }

    const result = await api.installThirdPartyModuleFolder(folder)
    if (!result.ok) {
      return {
        status: 'failed',
        message: result.message ?? result.issues?.[0]?.message ?? 'Could not install the extension module.',
      }
    }
    return {
      status: 'installed',
      id: result.id?.trim() || null,
      trust: result.trust ?? null,
    }
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : 'Extension module installation failed.',
    }
  }
}
