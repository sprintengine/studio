import type { SkillHarness } from './skills'

export const SKILL_PACK_HARNESSES: readonly SkillHarness[] = [
  'claude',
  'codex',
  'cursor',
  'gemini',
  'opencode',
  'grok',
  'agents',
]

export const SKILL_HARNESS_DIR: Record<SkillHarness, string> = {
  claude: '.claude',
  codex: '.codex',
  cursor: '.cursor',
  gemini: '.gemini',
  opencode: '.opencode',
  grok: '.grok',
  agents: '.agents',
}
