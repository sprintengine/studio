import type { MultiloopAgentSoulRole, SpecialistActionId } from '../types/workspace'

export type { MultiloopAgentSoulRole }

export type SpecialistIcon =
  | 'architecture'
  | 'code'
  | 'design'
  | 'review'
  | 'shield'
  | 'test'
  | 'infra'
  | 'product'
  | 'performance'

export type SpecialistAction = {
  id: SpecialistActionId
  label: string
  shortLabel: string
  description: string
  icon: SpecialistIcon
  promptFile: string
  shortcut?: string
}

export type MultiloopAgentSoul = {
  role: MultiloopAgentSoulRole
  label: string
  shortLabel: string
  promptFile: string
  icon: SpecialistIcon
}

export const MULTILOOP_AGENT_SOULS: MultiloopAgentSoul[] = [
  { role: 'coordinator', label: 'Coordinator', shortLabel: 'Coordinator', promptFile: 'coordinator.md', icon: 'architecture' },
  { role: 'architect', label: 'Architect', shortLabel: 'Architect', promptFile: 'architect.md', icon: 'architecture' },
  { role: 'product', label: 'Product', shortLabel: 'Product', promptFile: 'product.md', icon: 'product' },
  { role: 'developer', label: 'Developer', shortLabel: 'Developer', promptFile: 'developer.md', icon: 'code' },
  { role: 'frontend', label: 'Frontend', shortLabel: 'Frontend', promptFile: 'frontend.md', icon: 'design' },
  { role: 'tester', label: 'Tester', shortLabel: 'Tester', promptFile: 'tester.md', icon: 'test' },
  { role: 'security', label: 'Security', shortLabel: 'Security', promptFile: 'security.md', icon: 'shield' },
  { role: 'code_reviewer', label: 'Code Reviewer', shortLabel: 'Code Reviewer', promptFile: 'code_reviewer.md', icon: 'review' },
  { role: 'performance', label: 'Performance', shortLabel: 'Performance', promptFile: 'performance.md', icon: 'performance' },
]

export const SPECIALIST_ACTIONS: SpecialistAction[] = [
  {
    id: 'architect',
    label: 'Architecture Planning',
    shortLabel: 'Architect',
    description: 'Create implementation plans, compare approaches, and shape system design.',
    icon: 'architecture',
    promptFile: 'architect-prompt.md',
    shortcut: 'Ctrl+Alt+P',
  },
  {
    id: 'product-strategist',
    label: 'Product Strategist',
    shortLabel: 'Product Strategist',
    description: 'Research competitors, evaluate product value, sharpen positioning, and challenge weak strategy.',
    icon: 'product',
    promptFile: 'product-strategist-prompt.md',
  },
  {
    id: 'developer',
    label: 'Backend Development',
    shortLabel: 'Developer',
    description: 'Build reliable backend, API, data, and server-side implementation work.',
    icon: 'code',
    promptFile: 'developer-prompt.md',
  },
  {
    id: 'devops-infra',
    label: 'DevOps & Infrastructure',
    shortLabel: 'DevOps',
    description: 'Review deployment, infrastructure, observability, reliability, and operations.',
    icon: 'infra',
    promptFile: 'devops-infra-prompt.md',
  },
  {
    id: 'performance',
    label: 'Performance Engineer',
    shortLabel: 'Performance Engineer',
    description: 'Profile runtime behavior, memory use, CPU hot spots, bundle size, latency, and resource leaks.',
    icon: 'performance',
    promptFile: 'performance-engineer-prompt.md',
    shortcut: 'Ctrl+Alt+M',
  },
  {
    id: 'frontend-design-review',
    label: 'Frontend Designer',
    shortLabel: 'Frontend Designer',
    description: 'Design and implement polished frontend experiences, UI architecture, accessibility, and responsive behavior.',
    icon: 'design',
    promptFile: 'frontend-design-promt.md',
    shortcut: 'Ctrl+Alt+F',
  },
  {
    id: 'qa-test',
    label: 'QA and Test Specialist',
    shortLabel: 'QA Specialist',
    description: 'Plan test strategy, cover edge cases, verify regressions, and assess release quality.',
    icon: 'test',
    promptFile: 'qa-test-prompt.md',
  },
  {
    id: 'security-review',
    label: 'Security Specialist',
    shortLabel: 'Security Specialist',
    description: 'Inspect vulnerabilities, trust boundaries, secrets, permissions, and risky defaults.',
    icon: 'shield',
    promptFile: 'security-review-prompt.md',
  },
  {
    id: 'code-review',
    label: 'AI Slop Code Reviewer',
    shortLabel: 'AI Slop Reviewer',
    description: 'Review implementation quality, generic AI-code patterns, regressions, edge cases, and missing tests.',
    icon: 'review',
    promptFile: 'code-reviewer-pre-prompt.md',
  },
]

export function getSpecialistAction(id: SpecialistActionId | string | null | undefined): SpecialistAction {
  return SPECIALIST_ACTIONS.find((action) => action.id === id) ?? SPECIALIST_ACTIONS[0]
}

export function getMultiloopAgentSoul(role: MultiloopAgentSoulRole | string | null | undefined): MultiloopAgentSoul {
  return MULTILOOP_AGENT_SOULS.find((soul) => soul.role === role) ?? MULTILOOP_AGENT_SOULS[0]
}

export function buildMissingSpecialistPrompt(action: SpecialistAction, message?: string): string {
  return [
    'Specialist prompt file missing.',
    '',
    message ?? `Could not load specialist-prompts/${action.promptFile}.`,
    'Restore the prompt file or update the specialist prompt mapping, then restart this agent.',
  ].join('\n')
}

export async function loadSpecialistPrompt(specialistId: SpecialistActionId): Promise<string> {
  const action = getSpecialistAction(specialistId)

  try {
    const result = await window.api.readSpecialistPrompt(action.id)
    return result.ok ? result.prompt : buildMissingSpecialistPrompt(action, result.message)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return buildMissingSpecialistPrompt(action, message)
  }
}

export function buildMissingMultiloopAgentSoulPrompt(soul: MultiloopAgentSoul, message?: string): string {
  return [
    'Multiloop agent soul file missing.',
    '',
    message ?? `Could not load multiloop-agent-souls/${soul.promptFile}.`,
    'Restore the prompt file or update the Multiloop role mapping, then restart this agent.',
  ].join('\n')
}

export async function loadMultiloopAgentSoul(role: MultiloopAgentSoulRole): Promise<string> {
  const soul = getMultiloopAgentSoul(role)

  try {
    const result = await window.api.readMultiloopAgentSoul(soul.role)
    return result.ok ? result.prompt : buildMissingMultiloopAgentSoulPrompt(soul, result.message)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return buildMissingMultiloopAgentSoulPrompt(soul, message)
  }
}
