import { contextBridge } from 'electron'
import type { ElectronApi } from '../shared/electron-api'
import { DESKTOP_CLIENT_CAPABILITIES } from '../shared/client-capabilities'
import { readStudioEnv } from '../shared/studio-env'
import { instrumentApi, snapshotIpcStats } from './ipcStats'
import { apiModules } from './api-surface'
import { sshPreviewFromArgv } from '../shared/ssh-preview'

const diagnosticsEnabled = process.env.NODE_ENV === 'development' || readStudioEnv('SPRINTENGINE_DIAGNOSTICS') === '1'

const api = {
  platform: process.platform,
  // The desktop's server runs on this machine, in process or beside it.
  hostPlatform: process.platform,
  clientCapabilities: DESKTOP_CLIENT_CAPABILITIES,
  // SSH machines, a preview fixed for the session (shared/ssh-preview.ts).
  sshMachinesEnabled: sshPreviewFromArgv(process.argv),
  isDevelopment: process.env.NODE_ENV === 'development',
  isDiagnosticsEnabled: readStudioEnv('SPRINTENGINE_DIAGNOSTICS') === '1',
  diagnosticsGetIpcStats: snapshotIpcStats,
  ...apiModules,
} satisfies ElectronApi

// Wrap the whole surface for IPC accounting only when diagnostics is enabled, so
// there is zero per-call overhead in normal runs. instrumentApi preserves shape.
contextBridge.exposeInMainWorld('api', diagnosticsEnabled ? instrumentApi(api) : api)
