import type { IpcMain } from 'electron'
import type {
  BuiltinSkill,
  BuiltinSkillInstallResult,
  BuiltinSkillStatus,
} from '../../shared/electron-api'

type BuiltinSkillHandlers = {
  list(): Promise<BuiltinSkill[]>
  getStatus(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillStatus>
  install(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillInstallResult>
}

export function registerBuiltinSkillsIpc(ipcMain: IpcMain, handlers: BuiltinSkillHandlers): void {
  ipcMain.handle('builtin-skills:list', async (): Promise<BuiltinSkill[]> => handlers.list())
  ipcMain.handle(
    'builtin-skills:status',
    async (_, input: { workspaceRoot: string | null; skillId: string }): Promise<BuiltinSkillStatus> =>
      handlers.getStatus(input?.workspaceRoot ?? null, input?.skillId ?? '')
  )
  ipcMain.handle(
    'builtin-skills:install',
    async (_, input: { workspaceRoot: string | null; skillId: string }): Promise<BuiltinSkillInstallResult> =>
      handlers.install(input?.workspaceRoot ?? null, input?.skillId ?? '')
  )
}
