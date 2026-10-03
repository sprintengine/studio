import { contextBridge } from 'electron'
import type { ElectronApi } from '../shared/electron-api'
import { readStudioEnv } from '../shared/studio-env'
import { instrumentApi, snapshotIpcStats } from './ipcStats'
import { agentConfigImportApi } from './api/agent-config-import'
import { appMenuApi } from './api/app-menu'
import { appearanceApi } from './api/appearance'
import { authApi } from './api/auth'
import { automationApi } from './api/automation'
import { studioLocalAppsApi } from './api/studio-local-apps'
import { studioConnectionApi } from './api/studio-connection'
import { studioServerApi } from './api/studio-server'
import { meshApi } from './api/mesh'
import { scheduledAgentsApi } from './api/scheduled-agents'
import { backlogApi } from './api/backlog'
import { buildStampApi } from './api/build-stamp'
import { builtinSkillsApi } from './api/builtinSkills'
import { cliRuntimeApi } from './api/cli-runtime'
import { cliModelDiscoveryApi } from './api/cli-model-discovery'
import { textGenerationApi } from './api/text-generation'
import { clipboardApi } from './api/clipboard'
import { conversationApi } from './api/conversation'
import { conversationCommandsApi } from './api/conversation-commands'
import { conversationPeekApi } from './api/conversation-peek'
import { agentCompactApi } from './api/agent-compact'
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
import { launchSettingsApi } from './api/launch-settings'
import { hostsApi } from './api/hosts'
import { sshEnvironmentsApi } from './api/ssh-environments'
import { sshPreviewFromArgv } from '../shared/ssh-preview'
import { splashApi } from './api/splash'
import { startupApi } from './api/startup'
import { terminalApi } from './api/terminal'
import { updateApi } from './api/update'
import { voiceApi } from './api/voice'
import { windowApi } from './api/window'
import { browserApi } from './api/browser'
import { canvasApi } from './api/canvas'
import { editorRevealApi } from './api/editor-reveal'
import { toursApi } from './api/tours'
import { workspaceBackupApi } from './api/workspace-backup'
import { workspaceSkillsApi } from './api/workspace-skills'
import { workspaceSyncApi } from './api/workspace-sync'
import { extensionScaffoldApi } from './api/extension-scaffold'

const diagnosticsEnabled = process.env.NODE_ENV === 'development' || readStudioEnv('SPRINTENGINE_DIAGNOSTICS') === '1'

const api = {
  platform: process.platform,
  // SSH machines, a preview fixed for the session (shared/ssh-preview.ts).
  sshMachinesEnabled: sshPreviewFromArgv(process.argv),
  isDevelopment: process.env.NODE_ENV === 'development',
  isDiagnosticsEnabled: readStudioEnv('SPRINTENGINE_DIAGNOSTICS') === '1',
  diagnosticsGetIpcStats: snapshotIpcStats,
  ...agentConfigImportApi,
  ...windowApi,
  ...browserApi,
  ...canvasApi,
  ...editorRevealApi,
  ...toursApi,
  ...splashApi,
  ...startupApi,
  ...buildStampApi,
  ...appearanceApi,
  ...authApi,
  ...automationApi,
  ...studioLocalAppsApi,
  ...studioConnectionApi,
  ...studioServerApi,
  ...meshApi,
  ...scheduledAgentsApi,
  ...backlogApi,
  ...builtinSkillsApi,
  ...clipboardApi,
  ...cliRuntimeApi,
  ...cliModelDiscoveryApi,
  ...textGenerationApi,
  ...hostedSourcesFeedApi,
  ...hostedCardFeedApi,
  ...cliVersionApi,
  ...filesystemApi,
  ...launchSettingsApi,
  ...hostsApi,
  ...sshEnvironmentsApi,
  ...gitApi,
  ...marketplaceApi,
  ...memoryActivityApi,
  ...mcpApi,
  ...modulesApi,
  ...pluginsApi,
  ...conversationApi,
  ...conversationCommandsApi,
  ...conversationPeekApi,
  ...agentCompactApi,
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
  // ── extension-platform additions ──
  ...extensionScaffoldApi,
} satisfies ElectronApi

// Wrap the whole surface for IPC accounting only when diagnostics is enabled, so
// there is zero per-call overhead in normal runs. instrumentApi preserves shape.
contextBridge.exposeInMainWorld('api', diagnosticsEnabled ? instrumentApi(api) : api)
