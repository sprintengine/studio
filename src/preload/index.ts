import { contextBridge } from 'electron'
import type { ElectronApi } from '../shared/electron-api'
import { appMenuApi } from './api/app-menu'
import { authApi } from './api/auth'
import { filesystemApi } from './api/filesystem'
import { gitApi } from './api/git'
import { mobileBridgeApi } from './api/mobile-bridge'
import { multiloopApi } from './api/multiloop'
import { soulsApi } from './api/souls'
import { sprintEngineApi } from './api/sprintengine'
import { terminalApi } from './api/terminal'
import { updateApi } from './api/update'
import { windowApi } from './api/window'

const api = {
  platform: process.platform,
  isDevelopment: process.env.NODE_ENV === 'development',
  isDiagnosticsEnabled: process.env.MULTICODE_DIAGNOSTICS === '1',
  ...windowApi,
  ...authApi,
  ...mobileBridgeApi,
  ...filesystemApi,
  ...soulsApi,
  ...gitApi,
  ...sprintEngineApi,
  ...multiloopApi,
  ...terminalApi,
  ...updateApi,
  ...appMenuApi,
} satisfies ElectronApi

contextBridge.exposeInMainWorld('api', api)
