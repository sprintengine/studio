import type { IpcMain } from 'electron';
import type { SkillsService } from '../skills';
export declare function registerSkillsIpc(ipcMain: IpcMain, service: SkillsService): void;
