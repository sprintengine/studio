import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { MultiloopAgentSoulRole, SoulPromptResult, SpecialistActionId } from '../shared/electron-api'

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
    join(app.getAppPath(), 'souls', 'prompts', fileName),
    join(__dirname, '..', '..', 'souls', 'prompts', fileName),
    join(__dirname, '..', '..', '..', 'souls', 'prompts', fileName),
  ]
}

function getMultiloopAgentSoulCandidates(fileName: string): string[] {
  if (app.isPackaged) {
    return [
      join(process.resourcesPath, 'multiloop-agent-souls', fileName),
      join(app.getAppPath(), 'multiloop-agent-souls', fileName),
    ]
  }

  return [
    join(process.cwd(), 'multiloop-agent-souls', fileName),
    join(app.getAppPath(), 'multiloop-agent-souls', fileName),
    join(__dirname, '..', '..', 'multiloop-agent-souls', fileName),
    join(__dirname, '..', '..', '..', 'multiloop-agent-souls', fileName),
  ]
}

export async function readSpecialistSoul(specialistId: SpecialistActionId): Promise<SoulPromptResult> {
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
      // Try the next likely app/dev path before reporting a recoverable missing prompt.
    }
  }

  return {
    ok: false,
    message: `Soul file missing: souls/prompts/${role}.md`,
    path: candidates[0] ?? null,
  }
}

export async function readMultiloopAgentSoul(role: MultiloopAgentSoulRole): Promise<SoulPromptResult> {
  const fileName = multiloopAgentSoulFiles[role]
  if (!fileName) {
    return {
      ok: false,
      message: `Unknown Multiloop agent soul: ${role}`,
      path: null,
    }
  }

  const candidates = getMultiloopAgentSoulCandidates(fileName)

  for (const candidate of candidates) {
    try {
      return { ok: true, prompt: await readFile(candidate, 'utf-8'), path: candidate }
    } catch {
      // Try the next likely app/dev path before reporting a recoverable missing prompt.
    }
  }

  return {
    ok: false,
    message: `Prompt file missing: multiloop-agent-souls/${fileName}`,
    path: candidates[0] ?? null,
  }
}
