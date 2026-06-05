import { contextBridge } from 'electron'
import type { ElectronApi } from '../shared/electron-api'
import { appMenuApi } from './api/app-menu'
import { authApi } from './api/auth'
import { builtinSkillsApi } from './api/builtinSkills'
import { clipboardApi } from './api/clipboard'
import { conversationApi } from './api/conversation'
import { filesystemApi } from './api/filesystem'
import { gitApi } from './api/git'
import { layoutTemplatesApi } from './api/layout-templates'
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

const api = {
  platform: process.platform,
  isDevelopment: process.env.NODE_ENV === 'development',
  isDiagnosticsEnabled: process.env.MULTICODE_DIAGNOSTICS === '1',
  ...windowApi,
  ...authApi,
  ...builtinSkillsApi,
  ...clipboardApi,
  ...mobileBridgeApi,
  ...filesystemApi,
  ...soulsApi,
  ...gitApi,
  ...layoutTemplatesApi,
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

contextBridge.exposeInMainWorld('api', api)
