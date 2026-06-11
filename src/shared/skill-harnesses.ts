import type { SkillPackHarness } from './electron-api'

export const SKILL_PACK_HARNESSES: readonly SkillPackHarness[] = [
  'claude',
  'codex',
  'cursor',
  'gemini',
  'opencode',
  'agents',
]

export const SKILL_HARNESS_DIR: Record<SkillPackHarness, string> = {
  claude: '.claude',
  codex: '.codex',
  cursor: '.cursor',
  gemini: '.gemini',
  opencode: '.opencode',
  agents: '.agents',
}
