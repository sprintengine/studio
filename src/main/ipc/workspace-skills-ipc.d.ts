import type { IpcMain } from 'electron';
import type { AgentSkillInstaller } from '../agent-skill-installer';
import type { CapabilityWatcher } from '../capability-watcher';
import type { AgentCapabilityService, WorkspaceSkillsService } from '../workspace-skills-service';
export declare function registerWorkspaceSkillsIpc(ipcMain: IpcMain, services: {
    workspaceSkills: WorkspaceSkillsService;
    agentCapabilities: AgentCapabilityService;
    capabilityWatcher: CapabilityWatcher;
    agentSkillInstaller: AgentSkillInstaller;
}): void;
