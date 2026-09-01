import type { IpcMain } from 'electron';
import type { BuiltinSkill, BuiltinSkillInstallResult, BuiltinSkillStatus } from '../../shared/electron-api';
type BuiltinSkillHandlers = {
    list(): Promise<BuiltinSkill[]>;
    getStatus(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillStatus>;
    install(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillInstallResult>;
};
export declare function registerBuiltinSkillsIpc(ipcMain: IpcMain, handlers: BuiltinSkillHandlers): void;
export {};
