import { ipcRenderer } from 'electron'
import type { BuiltinSkill, BuiltinSkillStatus, ElectronApi, StudioPluginStatus } from '../../shared/electron-api'

export const builtinSkillsApi = {
  builtinSkillsList: (): Promise<BuiltinSkill[]> => ipcRenderer.invoke('builtin-skills:list'),

  builtinSkillStatus: (input: { workspaceRoot: string | null; skillId: string }): Promise<BuiltinSkillStatus> =>
    ipcRenderer.invoke('builtin-skills:status', input),

  // The app's own plugin. Beside the built-in skills because it is the same
  // idea one level up: something the app puts in a workspace and keeps there.
  studioPluginStatus: (input: { workspaceRoot: string | null }): Promise<StudioPluginStatus> =>
    ipcRenderer.invoke('studio-plugin:status', input),
} satisfies Pick<ElectronApi, 'builtinSkillsList' | 'builtinSkillStatus' | 'studioPluginStatus'>
