import type { IpcMain } from 'electron'
import type { BuiltinSkill, BuiltinSkillStatus } from '../../shared/electron-api'

// Read-only over IPC. The renderer lists and inspects; INSTALLING is the
// launcher's job, done in-process at spawn time (agent-skill-installer), so the
// bridge carries no install route — the `builtin-skills:install` channel and
// its `builtinSkillInstall` method left the tree on 2026-09-08 with the last
// caller.
type BuiltinSkillHandlers = {
  list(): Promise<BuiltinSkill[]>
  getStatus(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillStatus>
}

export function registerBuiltinSkillsIpc(ipcMain: IpcMain, handlers: BuiltinSkillHandlers): void {
  ipcMain.handle('builtin-skills:list', async (): Promise<BuiltinSkill[]> => handlers.list())
  ipcMain.handle(
    'builtin-skills:status',
    async (_, input: { workspaceRoot: string | null; skillId: string }): Promise<BuiltinSkillStatus> =>
      handlers.getStatus(input?.workspaceRoot ?? null, input?.skillId ?? '')
  )
}
