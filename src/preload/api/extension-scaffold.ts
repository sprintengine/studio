import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import type {
  ExtensionScaffoldCreateInput,
  ExtensionScaffoldCreateResult,
  ExtensionScaffoldTarget,
  ExtensionScaffoldTargetInput,
} from '../../shared/extension-scaffold'

// Build an extension (src/main/ipc/extension-scaffold-ipc.ts).
export const extensionScaffoldApi = {
  extensionScaffoldTarget: (input: ExtensionScaffoldTargetInput): Promise<ExtensionScaffoldTarget | null> =>
    ipcRenderer.invoke('extensions:scaffold:target', input),
  extensionScaffoldCreate: (input: ExtensionScaffoldCreateInput): Promise<ExtensionScaffoldCreateResult> =>
    ipcRenderer.invoke('extensions:scaffold:create', input),
} satisfies Pick<ElectronApi, 'extensionScaffoldTarget' | 'extensionScaffoldCreate'>
