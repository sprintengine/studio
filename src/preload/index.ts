import { contextBridge } from 'electron'
import type { ElectronApi } from '../shared/electron-api'
import { readStudioEnv } from '../shared/studio-env'
import { instrumentApi, snapshotIpcStats } from './ipcStats'
import { agentConfigImportApi } from './api/agent-config-import'
import { appMenuApi } from './api/app-menu'
import { appearanceApi } from './api/appearance'
import { authApi } from './api/auth'
import { automationApi } from './api/automation'
import { fleetApi } from './api/fleet'
import { automationsApi } from './api/automations'
import { backlogApi } from './api/backlog'
import { buildStampApi } from './api/build-stamp'
import { builtinSkillsApi } from './api/builtinSkills'
import { cliRuntimeApi } from './api/cli-runtime'
import { cliModelDiscoveryApi } from './api/cli-model-discovery'
import { textGenerationApi } from './api/text-generation'
import { clipboardApi } from './api/clipboard'
import { conversationApi } from './api/conversation'
import { conversationPeekApi } from './api/conversation-peek'
import { pullRequestApi } from './api/pull-request'
import { credentialApi } from './api/credential'
import { designSystemApi } from './api/design-system'
import { filesystemApi } from './api/filesystem'
import { gitApi } from './api/git'
import { marketplaceApi } from './api/marketplace'
import { hostedSourcesFeedApi } from './api/hosted-sources-feed'
import { hostedCardFeedApi } from './api/hosted-card-feed'
import { cliVersionApi } from './api/cli-version'
import { memoryActivityApi } from './api/memoryActivity'
import { mcpApi } from './api/mcp'
import { modulesApi } from './api/modules'
import { pluginsApi } from './api/plugins'
import { skillsApi } from './api/skills'
import { mobileBridgeApi } from './api/mobile-bridge'
import { launchSettingsApi } from './api/launch-settings'
import { hostsApi } from './api/hosts'
import { splashApi } from './api/splash'
import { startupApi } from './api/startup'
import { terminalApi } from './api/terminal'
import { updateApi } from './api/update'
import { voiceApi } from './api/voice'
import { windowApi } from './api/window'
import { browserApi } from './api/browser'
import { canvasApi } from './api/canvas'
import { editorRevealApi } from './api/editor-reveal'
import { workspaceBackupApi } from './api/workspace-backup'
import { workspaceSkillsApi } from './api/workspace-skills'
import { workspaceSyncApi } from './api/workspace-sync'

const diagnosticsEnabled = process.env.NODE_ENV === 'development' || readStudioEnv('SPRINTENGINE_DIAGNOSTICS') === '1'

const api = {
  platform: process.platform,
  isDevelopment: process.env.NODE_ENV === 'development',
  isDiagnosticsEnabled: readStudioEnv('SPRINTENGINE_DIAGNOSTICS') === '1',
  diagnosticsGetIpcStats: snapshotIpcStats,
  ...agentConfigImportApi,
  ...windowApi,
  ...browserApi,
  ...canvasApi,
  ...editorRevealApi,
  ...splashApi,
  ...startupApi,
  ...buildStampApi,
  ...appearanceApi,
  ...authApi,
  ...automationApi,
  ...fleetApi,
  ...automationsApi,
  ...backlogApi,
  ...builtinSkillsApi,
  ...clipboardApi,
  ...cliRuntimeApi,
  ...cliModelDiscoveryApi,
  ...textGenerationApi,
  ...hostedSourcesFeedApi,
  ...hostedCardFeedApi,
  ...cliVersionApi,
  ...mobileBridgeApi,
  ...filesystemApi,
  ...launchSettingsApi,
  ...hostsApi,
  ...gitApi,
  ...marketplaceApi,
  ...memoryActivityApi,
  ...mcpApi,
  ...modulesApi,
  ...pluginsApi,
  ...conversationApi,
  ...conversationPeekApi,
  ...pullRequestApi,
  ...credentialApi,
  ...designSystemApi,
  ...skillsApi,
  ...terminalApi,
  ...updateApi,
  ...voiceApi,
  ...appMenuApi,
  ...workspaceBackupApi,
  ...workspaceSkillsApi,
  ...workspaceSyncApi,
} satisfies ElectronApi

// Wrap the whole surface for IPC accounting only when diagnostics is enabled, so
// there is zero per-call overhead in normal runs. instrumentApi preserves shape.
contextBridge.exposeInMainWorld('api', diagnosticsEnabled ? instrumentApi(api) : api)
