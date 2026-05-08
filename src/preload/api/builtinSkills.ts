import { ipcRenderer } from 'electron'
import type {
  BuiltinSkill,
  BuiltinSkillInstallResult,
  BuiltinSkillStatus,
  ElectronApi,
} from '../../shared/electron-api'

export const builtinSkillsApi = {
  builtinSkillsList: (): Promise<BuiltinSkill[]> =>
    ipcRenderer.invoke('builtin-skills:list'),

  builtinSkillStatus: (
    input: { workspaceRoot: string | null; skillId: string }
  ): Promise<BuiltinSkillStatus> =>
    ipcRenderer.invoke('builtin-skills:status', input),

  builtinSkillInstall: (
    input: { workspaceRoot: string | null; skillId: string }
  ): Promise<BuiltinSkillInstallResult> =>
    ipcRenderer.invoke('builtin-skills:install', input),
} satisfies Pick<
  ElectronApi,
  | 'builtinSkillsList'
  | 'builtinSkillStatus'
  | 'builtinSkillInstall'
>
