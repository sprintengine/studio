import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  MultiloopRole,
  SoulPromptResult,
  SpecialistActionId,
} from '../../shared/electron-api'

async function readSpecialistSoul(specialistId: SpecialistActionId): Promise<SoulPromptResult> {
  try {
    return await ipcRenderer.invoke('souls:read-specialist', specialistId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("No handler registered for 'souls:read-specialist'")) {
      return {
        ok: false,
        message: 'Souls IPC handler is not registered. Restart the app to reconnect to the Souls registry.',
        path: null,
      }
    }
    throw error
  }
}

async function readMultiloopPromptFallback(role: MultiloopRole): Promise<SoulPromptResult> {
  return {
    ok: true,
    prompt: buildMultiloopPromptFetchInstruction(role),
    path: 'multiloop_core/prompts.py',
  }
}

function buildMultiloopPromptFetchInstruction(role: MultiloopRole): string {
  if (role === 'coordinator') {
    return [
      'Fetch your current Multiloop coordinator prompt from the Multiloop CLI before doing role-specific work.',
      '',
      'Run:',
      '',
      '```bash',
      'scripts/multiloop --state <state-path> milestone plan-next',
      '```',
      '',
      'Treat the returned text as the active Multiloop coordination prompt.',
    ].join('\n')
  }

  return [
    'Fetch your current Multiloop role prompt from the Multiloop CLI before doing role-specific work.',
    '',
    'Run:',
    '',
    '```bash',
    `scripts/multiloop --state <state-path> milestone review --role ${role}`,
    '```',
    '',
    'Treat the returned text as read-only Multiloop milestone context and follow the linked Sprint Engine task instructions for execution.',
  ].join('\n')
}

async function readMultiloopPrompt(role: MultiloopRole): Promise<SoulPromptResult> {
  try {
    return await ipcRenderer.invoke('multiloop:read-prompt', role)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("No handler registered for 'multiloop:read-prompt'")) {
      return readMultiloopPromptFallback(role)
    }
    throw error
  }
}

export const soulsApi = {
  readSpecialistSoul,
  readMultiloopPrompt,
} satisfies Pick<ElectronApi, 'readSpecialistSoul' | 'readMultiloopPrompt'>
