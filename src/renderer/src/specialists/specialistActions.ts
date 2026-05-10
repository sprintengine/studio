import type { MultiloopRole, SpecialistActionId } from '../types/workspace'

export type { MultiloopRole }

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
  | 'writing'

export type SpecialistAction = {
  id: SpecialistActionId
  label: string
  shortLabel: string
  description: string
  icon: SpecialistIcon
  soulRole: string
  soulFile: string
  shortcut?: string
}

export type MultiloopRoleDescriptor = {
  role: MultiloopRole
  label: string
  shortLabel: string
  icon: SpecialistIcon
}

export const MULTILOOP_ROLES: MultiloopRoleDescriptor[] = [
  { role: 'coordinator', label: 'Coordinator', shortLabel: 'Coordinator', icon: 'architecture' },
  { role: 'architect', label: 'Architect', shortLabel: 'Architect', icon: 'architecture' },
  { role: 'product', label: 'Product', shortLabel: 'Product', icon: 'product' },
  { role: 'developer', label: 'Developer', shortLabel: 'Developer', icon: 'code' },
  { role: 'frontend', label: 'Frontend', shortLabel: 'Frontend', icon: 'design' },
  { role: 'tester', label: 'Tester', shortLabel: 'Tester', icon: 'test' },
  { role: 'security', label: 'Security', shortLabel: 'Security', icon: 'shield' },
  { role: 'code_reviewer', label: 'Code Reviewer', shortLabel: 'Code Reviewer', icon: 'review' },
  { role: 'performance', label: 'Performance', shortLabel: 'Performance', icon: 'performance' },
]

export const SPECIALIST_ACTIONS: SpecialistAction[] = [
  {
    id: 'architect',
    label: 'Architecture Planning',
    shortLabel: 'Architect',
    description: 'Create implementation plans, compare approaches, and shape system design.',
    icon: 'architecture',
    soulRole: 'architect',
    soulFile: 'architect.md',
    shortcut: 'Ctrl+Alt+P',
  },
  {
    id: 'product-strategist',
    label: 'Product Strategist',
    shortLabel: 'Product Strategist',
    description: 'Research competitors, evaluate product value, sharpen positioning, and challenge weak strategy.',
    icon: 'product',
    soulRole: 'product',
    soulFile: 'product.md',
  },
  {
    id: 'developer',
    label: 'Backend Development',
    shortLabel: 'Developer',
    description: 'Build reliable backend, API, data, and server-side implementation work.',
    icon: 'code',
    soulRole: 'developer',
    soulFile: 'developer.md',
  },
  {
    id: 'devops-infra',
    label: 'DevOps & Infrastructure',
    shortLabel: 'DevOps',
    description: 'Review deployment, infrastructure, observability, reliability, and operations.',
    icon: 'infra',
    soulRole: 'devops',
    soulFile: 'devops.md',
  },
  {
    id: 'performance',
    label: 'Performance Engineer',
    shortLabel: 'Performance Engineer',
    description: 'Profile runtime behavior, memory use, CPU hot spots, bundle size, latency, and resource leaks.',
    icon: 'performance',
    soulRole: 'performance',
    soulFile: 'performance.md',
    shortcut: 'Ctrl+Alt+M',
  },
  {
    id: 'frontend-design-review',
    label: 'Frontend Designer',
    shortLabel: 'Frontend Designer',
    description: 'Design and implement polished frontend experiences, UI architecture, accessibility, and responsive behavior.',
    icon: 'design',
    soulRole: 'frontend',
    soulFile: 'frontend.md',
    shortcut: 'Ctrl+Alt+F',
  },
  {
    id: 'blog-writer',
    label: 'Blog Writer',
    shortLabel: 'Blog Writer',
    description: 'Research, draft, edit, and package publish-ready blog posts with natural prose and image direction.',
    icon: 'writing',
    soulRole: 'blog_writer',
    soulFile: 'blog_writer.md',
  },
  {
    id: 'qa-test',
    label: 'QA and Test Specialist',
    shortLabel: 'QA Specialist',
    description: 'Plan test strategy, cover edge cases, verify regressions, and assess release quality.',
    icon: 'test',
    soulRole: 'tester',
    soulFile: 'tester.md',
  },
  {
    id: 'security-review',
    label: 'Security Specialist',
    shortLabel: 'Security Specialist',
    description: 'Inspect vulnerabilities, trust boundaries, secrets, permissions, and risky defaults.',
    icon: 'shield',
    soulRole: 'security',
    soulFile: 'security.md',
  },
  {
    id: 'code-review',
    label: 'AI Slop Code Reviewer',
    shortLabel: 'AI Slop Reviewer',
    description: 'Review implementation quality, generic AI-code patterns, regressions, edge cases, and missing tests.',
    icon: 'review',
    soulRole: 'code_reviewer',
    soulFile: 'code_reviewer.md',
  },
]

export function getSpecialistAction(id: SpecialistActionId | string | null | undefined): SpecialistAction {
  return SPECIALIST_ACTIONS.find((action) => action.id === id) ?? SPECIALIST_ACTIONS[0]
}

export function getMultiloopRole(role: MultiloopRole | string | null | undefined): MultiloopRoleDescriptor {
  return MULTILOOP_ROLES.find((descriptor) => descriptor.role === role) ?? MULTILOOP_ROLES[0]
}

export function buildMissingSpecialistSoul(action: SpecialistAction, message?: string): string {
  return [
    'Soul file missing.',
    '',
    message ?? `Could not load souls/prompts/${action.soulFile}.`,
    'Restore the Soul file or update the Soul mapping, then restart this agent.',
  ].join('\n')
}

export async function loadSpecialistSoul(specialistId: SpecialistActionId): Promise<string> {
  const action = getSpecialistAction(specialistId)

  try {
    const result = await window.api.readSpecialistSoul(action.id)
    return result.ok ? result.prompt : buildMissingSpecialistSoul(action, result.message)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return buildMissingSpecialistSoul(action, message)
  }
}

export function buildSpecialistSoulStartupPrompt(action: SpecialistAction): string {
  return [
    'Fetch your Soul from the Souls CLI before doing any role-specific work.',
    '',
    `First try: \`souls get ${action.soulRole}\`.`,
    '',
    'If `souls` is not on PATH, use the command form for your shell:',
    '',
    '```powershell',
    `.\\scripts\\souls.cmd get ${action.soulRole}`,
    '```',
    '',
    '```bash',
    `scripts/souls get ${action.soulRole}`,
    '```',
    '',
    'If the wrapper is unavailable but Python can import the local repo package, run:',
    '',
    '```powershell',
    `python -m souls get ${action.soulRole}`,
    '```',
    '',
    '```bash',
    `python3 -m souls get ${action.soulRole}`,
    '```',
    '',
    'Treat the returned text as your role, judgment, and quality bar.',
    '',
    'Only if all of those commands fail, stop and report that the Souls CLI is unavailable instead of guessing the role prompt.',
  ].join('\n')
}

export function buildMissingMultiloopPrompt(descriptor: MultiloopRoleDescriptor, message?: string): string {
  return [
    'Multiloop role prompt unavailable.',
    '',
    message ?? `Could not load Multiloop prompt for ${descriptor.role}.`,
    'Restore multiloop_core/prompts.py or update the Multiloop role mapping, then restart this agent.',
  ].join('\n')
}

export async function loadMultiloopPrompt(role: MultiloopRole): Promise<string> {
  const descriptor = getMultiloopRole(role)

  try {
    const result = await window.api.readMultiloopPrompt(descriptor.role)
    return result.ok ? result.prompt : buildMissingMultiloopPrompt(descriptor, result.message)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return buildMissingMultiloopPrompt(descriptor, message)
  }
}
