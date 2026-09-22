/** A physical installation, never deduplicated by its display name. */
export type InstalledSkill = {
  id: string
  name: string
  description: string
  path: string
  scope: 'project' | 'global'
  origin: string
  linked: boolean
  removable: boolean
  removalNote?: string
}

export type InstalledSkillsInput = { workspaceRoot: string | null; pluginId: string }
export type InstalledSkillsResult =
  { ok: true; skills: InstalledSkill[]; diagnostics: string[] } | { ok: false; message: string }
export type InstalledSkillRemoveInput = InstalledSkillsInput & { installationId: string }
export type InstalledSkillRemoveResult = { ok: true } | { ok: false; message: string }
