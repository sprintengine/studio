import { contextBridge } from 'electron'
import type { ElectronApi } from '../shared/electron-api'
import { instrumentApi, snapshotIpcStats } from './ipcStats'
import { appMenuApi } from './api/app-menu'
import { appearanceApi } from './api/appearance'
import { authApi } from './api/auth'
import { automationApi } from './api/automation'
import { backlogApi } from './api/backlog'
import { builtinSkillsApi } from './api/builtinSkills'
import { cliRuntimeApi } from './api/cli-runtime'
import { clipboardApi } from './api/clipboard'
import { conversationApi } from './api/conversation'
import { filesystemApi } from './api/filesystem'
import { gitApi } from './api/git'
import { layoutTemplatesApi } from './api/layout-templates'
import { marketplaceApi } from './api/marketplace'
import { memoryActivityApi } from './api/memoryActivity'
import { mcpApi } from './api/mcp'
import { modulesApi } from './api/modules'
import { pluginsApi } from './api/plugins'
import { skillPackApi } from './api/skill-pack'
import { mobileBridgeApi } from './api/mobile-bridge'
import { multiloopApi } from './api/multiloop'
import { soulsApi } from './api/souls'
import { sprintEngineApi } from './api/sprintengine'
import { switchboardApi } from './api/switchboard'
import { terminalApi } from './api/terminal'
import { updateApi } from './api/update'
import { voiceApi } from './api/voice'
import { windowApi } from './api/window'
import { workspaceBackupApi } from './api/workspace-backup'
import { workspaceSyncApi } from './api/workspace-sync'

const diagnosticsEnabled =
  process.env.NODE_ENV === 'development' || process.env.MULTICODE_DIAGNOSTICS === '1'

const api = {
  platform: process.platform,
  isDevelopment: process.env.NODE_ENV === 'development',
  isDiagnosticsEnabled: process.env.MULTICODE_DIAGNOSTICS === '1',
  diagnosticsGetIpcStats: snapshotIpcStats,
  ...windowApi,
  ...appearanceApi,
  ...authApi,
  ...automationApi,
  ...backlogApi,
  ...builtinSkillsApi,
  ...clipboardApi,
  ...cliRuntimeApi,
  ...mobileBridgeApi,
  ...filesystemApi,
  ...soulsApi,
  ...gitApi,
  ...layoutTemplatesApi,
  ...marketplaceApi,
  ...memoryActivityApi,
  ...mcpApi,
  ...modulesApi,
  ...pluginsApi,
  ...conversationApi,
  ...skillPackApi,
  ...sprintEngineApi,
  ...switchboardApi,
  ...multiloopApi,
  ...terminalApi,
  ...updateApi,
  ...voiceApi,
  ...appMenuApi,
  ...workspaceBackupApi,
  ...workspaceSyncApi,
} satisfies ElectronApi

// Wrap the whole surface for IPC accounting only when diagnostics is enabled, so
// there is zero per-call overhead in normal runs. instrumentApi preserves shape.
contextBridge.exposeInMainWorld('api', diagnosticsEnabled ? instrumentApi(api) : api)
