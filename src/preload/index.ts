import { contextBridge } from 'electron'
import type { ElectronApi } from '../shared/electron-api'
import { appMenuApi } from './api/app-menu'
import { authApi } from './api/auth'
import { builtinSkillsApi } from './api/builtinSkills'
import { filesystemApi } from './api/filesystem'
import { gitApi } from './api/git'
import { layoutTemplatesApi } from './api/layout-templates'
import { memoryActivityApi } from './api/memoryActivity'
import { mcpApi } from './api/mcp'
import { modulesApi } from './api/modules'
import { skillPackApi } from './api/skill-pack'
import { mobileBridgeApi } from './api/mobile-bridge'
import { multiloopApi } from './api/multiloop'
import { soulsApi } from './api/souls'
import { sprintEngineApi } from './api/sprintengine'
import { switchboardApi } from './api/switchboard'
import { terminalApi } from './api/terminal'
import { updateApi } from './api/update'
import { windowApi } from './api/window'
import { workspaceBackupApi } from './api/workspace-backup'

const api = {
  platform: process.platform,
  isDevelopment: process.env.NODE_ENV === 'development',
  isDiagnosticsEnabled: process.env.MULTICODE_DIAGNOSTICS === '1',
  ...windowApi,
  ...authApi,
  ...builtinSkillsApi,
  ...mobileBridgeApi,
  ...filesystemApi,
  ...soulsApi,
  ...gitApi,
  ...layoutTemplatesApi,
  ...memoryActivityApi,
  ...mcpApi,
  ...modulesApi,
  ...skillPackApi,
  ...sprintEngineApi,
  ...switchboardApi,
  ...multiloopApi,
  ...terminalApi,
  ...updateApi,
  ...appMenuApi,
  ...workspaceBackupApi,
} satisfies ElectronApi

contextBridge.exposeInMainWorld('api', api)
