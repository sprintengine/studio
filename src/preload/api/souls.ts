import { ipcRenderer } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type {
  ElectronApi,
  MultiloopRole,
  SoulPromptResult,
  SpecialistActionId,
} from '../../shared/electron-api'

const specialistSoulRoles: Record<SpecialistActionId, string> = {
  architect: 'architect',
  'product-strategist': 'product',
  developer: 'developer',
  'devops-infra': 'devops',
  performance: 'performance',
  'frontend-design-review': 'frontend',
  'qa-test': 'tester',
  'security-review': 'security',
  'code-review': 'code_reviewer',
}

function getSoulPromptCandidates(role: string): string[] {
  const fileName = `${role}.md`
  return [
    join(process.cwd(), 'souls', 'prompts', fileName),
    join(__dirname, '..', '..', 'souls', 'prompts', fileName),
    join(__dirname, '..', '..', '..', 'souls', 'prompts', fileName),
  ]
}

async function readSpecialistSoulFallback(specialistId: SpecialistActionId): Promise<SoulPromptResult> {
  const role = specialistSoulRoles[specialistId]
  if (!role) {
    return {
      ok: false,
      message: `Unknown Soul: ${specialistId}`,
      path: null,
    }
  }

  const candidates = getSoulPromptCandidates(role)
  for (const candidate of candidates) {
    try {
      return { ok: true, prompt: await readFile(candidate, 'utf-8'), path: candidate }
    } catch {
      // Keep checking the next dev/build prompt path.
    }
  }

  return {
    ok: false,
    message: `Soul file missing: souls/prompts/${role}.md`,
    path: candidates[0] ?? null,
  }
}

async function readSpecialistSoul(specialistId: SpecialistActionId): Promise<SoulPromptResult> {
  try {
    return await ipcRenderer.invoke('souls:read-specialist', specialistId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("No handler registered for 'souls:read-specialist'")) {
      return readSpecialistSoulFallback(specialistId)
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
