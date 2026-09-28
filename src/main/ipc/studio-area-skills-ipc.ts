// The built-in plugin's area skills: read the person's choices, switch one on
// or off, and turn a surface's suggestion down. Every change is broadcast, so a
// surface's suggestion and the Settings switch stay in step across windows.

import { BrowserWindow, type IpcMain } from 'electron'

import {
  isStudioAreaSkillId,
  type StudioAreaSkillChoices,
  type StudioAreaSkillId,
} from '../../shared/studio-area-skills'
import type { StudioAreaSkillStore } from '../studio-area-skill-store'

const STUDIO_AREA_SKILLS_GET_CHANNEL = 'studio-area-skills:get'
const STUDIO_AREA_SKILLS_SET_ENABLED_CHANNEL = 'studio-area-skills:set-enabled'
const STUDIO_AREA_SKILLS_DISMISS_CHANNEL = 'studio-area-skills:dismiss'
const STUDIO_AREA_SKILLS_CHANGED_CHANNEL = 'studio-area-skills:changed'

export function registerStudioAreaSkillsIpc(
  ipcMain: IpcMain,
  store: StudioAreaSkillStore,
  deps: { getWindows?: () => BrowserWindow[] } = {},
): void {
  const getWindows = deps.getWindows ?? (() => BrowserWindow.getAllWindows())
  store.onChange((choices) => {
    for (const window of getWindows()) {
      if (!window.isDestroyed()) window.webContents.send(STUDIO_AREA_SKILLS_CHANGED_CHANNEL, choices)
    }
  })

  ipcMain.handle(STUDIO_AREA_SKILLS_GET_CHANNEL, (): StudioAreaSkillChoices => store.read())

  ipcMain.handle(
    STUDIO_AREA_SKILLS_SET_ENABLED_CHANNEL,
    async (_, input: { skillId?: unknown; enabled?: unknown }): Promise<StudioAreaSkillChoices> => {
      const id = requireSkillId(input?.skillId)
      return store.setEnabled(id, input?.enabled === true)
    },
  )

  ipcMain.handle(
    STUDIO_AREA_SKILLS_DISMISS_CHANNEL,
    async (_, input: { skillId?: unknown }): Promise<StudioAreaSkillChoices> =>
      store.dismiss(requireSkillId(input?.skillId)),
  )
}

function requireSkillId(value: unknown): StudioAreaSkillId {
  if (!isStudioAreaSkillId(value)) throw new Error(`Unknown Studio skill: ${String(value)}`)
  return value
}
