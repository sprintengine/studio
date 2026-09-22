import { execFile } from 'node:child_process'
import { shell, type IpcMain } from 'electron'
import {
  createInstalledSkillsService,
  parseWslProbe,
  WSL_PROBE_SCRIPT,
  type WslHome,
} from '../installed-skills-service'
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

// Asks the default WSL distribution where its home is, once a minute at most:
// the Skills tab re-reads on every open and on Refresh, and each ask starts a
// login shell. A failure is not cached, so the next open tries again.
const WSL_PROBE_TTL_MS = 60_000
function cachedWslProbe(): () => Promise<WslHome | null> {
  let cached: { at: number; value: Promise<WslHome | null> } | null = null
  return () => {
    if (cached && Date.now() - cached.at < WSL_PROBE_TTL_MS) return cached.value
    const value = new Promise<WslHome | null>((resolve) => {
      execFile(
        'wsl.exe',
        ['-e', 'bash', '-lc', WSL_PROBE_SCRIPT],
        { timeout: 10_000, windowsHide: true },
        (error, stdout) => resolve(error ? null : parseWslProbe(String(stdout))),
      )
    })
    const entry = { at: Date.now(), value }
    cached = entry
    void value.then((result) => {
      if (!result && cached === entry) cached = null
    })
    return value
  }
}

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
    ...(process.platform === 'win32' ? { probeWsl: cachedWslProbe() } : {}),
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
