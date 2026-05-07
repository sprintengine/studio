import { ipcRenderer } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type {
  ElectronApi,
  MultiloopAgentSoulRole,
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

const multiloopAgentSoulFiles: Record<MultiloopAgentSoulRole, string> = {
  coordinator: 'coordinator.md',
  architect: 'architect.md',
  product: 'product.md',
  developer: 'developer.md',
  frontend: 'frontend.md',
  tester: 'tester.md',
  security: 'security.md',
  code_reviewer: 'code_reviewer.md',
  performance: 'performance.md',
}

function getSoulPromptCandidates(role: string): string[] {
  const fileName = `${role}.md`
  return [
    join(process.cwd(), 'souls', 'prompts', fileName),
    join(__dirname, '..', '..', 'souls', 'prompts', fileName),
    join(__dirname, '..', '..', '..', 'souls', 'prompts', fileName),
  ]
}

function getMultiloopAgentSoulCandidates(fileName: string): string[] {
  if (process.env.NODE_ENV !== 'development' && !process.env.ELECTRON_RENDERER_URL) {
    return []
  }

  return [
    join(process.cwd(), 'multiloop-agent-souls', fileName),
    join(__dirname, '..', '..', 'multiloop-agent-souls', fileName),
    join(__dirname, '..', '..', '..', 'multiloop-agent-souls', fileName),
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

async function readMultiloopAgentSoulFallback(role: MultiloopAgentSoulRole): Promise<SoulPromptResult> {
  const fileName = multiloopAgentSoulFiles[role]
  if (!fileName) {
    return {
      ok: false,
      message: `Unknown Multiloop agent soul: ${role}`,
      path: null,
    }
  }

  const candidates = getMultiloopAgentSoulCandidates(fileName)
  if (candidates.length === 0) {
    return {
      ok: false,
      message: `Packaged Multiloop agent soul missing from trusted app assets: multiloop-agent-souls/${fileName}`,
      path: null,
    }
  }

  for (const candidate of candidates) {
    try {
      return { ok: true, prompt: await readFile(candidate, 'utf-8'), path: candidate }
    } catch {
      // Keep checking the next dev/build prompt path.
    }
  }

  return {
    ok: false,
    message: `Prompt file missing: multiloop-agent-souls/${fileName}`,
    path: candidates[0] ?? null,
  }
}

async function readMultiloopAgentSoul(role: MultiloopAgentSoulRole): Promise<SoulPromptResult> {
  try {
    return await ipcRenderer.invoke('multiloop:read-agent-soul', role)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("No handler registered for 'multiloop:read-agent-soul'")) {
      return readMultiloopAgentSoulFallback(role)
    }
    throw error
  }
}

export const soulsApi = {
  readSpecialistSoul,
  readMultiloopAgentSoul,
} satisfies Pick<ElectronApi, 'readSpecialistSoul' | 'readMultiloopAgentSoul'>
