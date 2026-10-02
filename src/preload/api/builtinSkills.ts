import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type { BuiltinSkill, BuiltinSkillStatus, ElectronApi, StudioPluginStatus } from '../../shared/electron-api'
import type { StudioAreaSkillChoices, StudioAreaSkillId } from '../../shared/studio-area-skills'

const STUDIO_AREA_SKILLS_CHANGED_CHANNEL = 'studio-area-skills:changed'

export const builtinSkillsApi = {
  builtinSkillsList: (): Promise<BuiltinSkill[]> => ipcRenderer.invoke('builtin-skills:list'),

  builtinSkillStatus: (input: { workspaceRoot: string | null; skillId: string }): Promise<BuiltinSkillStatus> =>
    ipcRenderer.invoke('builtin-skills:status', input),

  // The app's own plugin. Beside the built-in skills because it is the same
  // idea one level up: something the app puts in a workspace and keeps there.
  studioPluginStatus: (input: { workspaceRoot: string | null }): Promise<StudioPluginStatus> =>
    ipcRenderer.invoke('studio-plugin:status', input),

  // Its area skills, which are the person's to choose.
  studioAreaSkillsGet: (): Promise<StudioAreaSkillChoices> => ipcRenderer.invoke('studio-area-skills:get'),
  studioAreaSkillsSetEnabled: (input: {
    skillId: StudioAreaSkillId
    enabled: boolean
  }): Promise<StudioAreaSkillChoices> => ipcRenderer.invoke('studio-area-skills:set-enabled', input),
  studioAreaSkillsDismiss: (input: { skillId: StudioAreaSkillId }): Promise<StudioAreaSkillChoices> =>
    ipcRenderer.invoke('studio-area-skills:dismiss', input),
  onStudioAreaSkillsChanged: (cb: (choices: StudioAreaSkillChoices) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, choices: StudioAreaSkillChoices) => cb(choices)
    ipcRenderer.on(STUDIO_AREA_SKILLS_CHANGED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(STUDIO_AREA_SKILLS_CHANGED_CHANNEL, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'builtinSkillsList'
  | 'builtinSkillStatus'
  | 'studioPluginStatus'
  | 'studioAreaSkillsGet'
  | 'studioAreaSkillsSetEnabled'
  | 'studioAreaSkillsDismiss'
  | 'onStudioAreaSkillsChanged'
>
