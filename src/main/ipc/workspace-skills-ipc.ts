import { shell, type IpcMain } from 'electron'
import { createInstalledSkillsService } from '../installed-skills-service'
import { probeWslHome } from '../wsl-home'
import { listPluginRegistryEntries } from '../plugin-registry-instance'
import type { InstalledSkillsInput, InstalledSkillRemoveInput } from '../../shared/installed-skills'
import type {
  AgentSkillWriteInput,
  AgentSkillWriteResult,
  WorkspaceSkillsListInput,
  WorkspaceSkillsListResult,
} from '../../shared/electron-api'
import type { AgentSkillInstaller } from '../agent-skill-installer'
import type { AgentCapabilitiesInput, AgentCapabilitiesResult } from '../../shared/skills'
import type { AgentCapabilityService, WorkspaceSkillsService } from '../workspace-skills-service'

export function registerWorkspaceSkillsIpc(
  ipcMain: IpcMain,
  services: {
    workspaceSkills: WorkspaceSkillsService
    agentCapabilities: AgentCapabilityService
    agentSkillInstaller: AgentSkillInstaller
  },
): void {
  const installed = createInstalledSkillsService({
    listPlugins: listPluginRegistryEntries,
    trashItem: (path) => shell.trashItem(path),
    // The machine's distribution's home (else the default's), cached for a
    // minute across the app.
    ...(process.platform === 'win32' ? { probeWsl: (distro?: string | null) => probeWslHome(distro) } : {}),
  })
  ipcMain.handle('skills:list-installed', (_, input: InstalledSkillsInput) => installed.list(input))
  ipcMain.handle('skills:remove-installed', (_, input: InstalledSkillRemoveInput) => installed.remove(input))
  ipcMain.handle('skills:list-workspace', (_, input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult> =>
    services.workspaceSkills.listWorkspaceSkills(input),
  )
  ipcMain.handle('skills:agent-capabilities', (_, input: AgentCapabilitiesInput): Promise<AgentCapabilitiesResult> =>
    services.agentCapabilities.resolve(input),
  )
  ipcMain.handle('skills:agent-skill-attach', (_, input: AgentSkillWriteInput): Promise<AgentSkillWriteResult> =>
    services.agentSkillInstaller.attach(input),
  )
}
