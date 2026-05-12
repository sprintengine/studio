import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { MultiloopRole, SoulPromptResult, SpecialistActionId } from '../shared/electron-api'

const specialistSoulRoles: Record<SpecialistActionId, string> = {
  architect: 'architect',
  'product-strategist': 'product',
  developer: 'developer',
  'devops-infra': 'devops',
  performance: 'performance',
  'blog-writer': 'blog_writer',
  'frontend-design-review': 'frontend',
  'qa-test': 'tester',
  'security-review': 'security',
  'code-review': 'code_reviewer',
  'spec-review': 'spec_reviewer',
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

export async function readMultiloopPrompt(role: MultiloopRole): Promise<SoulPromptResult> {
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
