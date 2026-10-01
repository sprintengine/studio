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

export type InstalledSkillsInput = {
  workspaceRoot: string | null
  pluginId: string
  /**
   * `wsl` when the CLI runs inside WSL on Windows, so its user folders are read
   * from the Linux home rather than the Windows profile. Absent means the CLI
   * runs on this machine's own filesystem.
   */
  pathStyle?: 'wsl'
  /** With `pathStyle: 'wsl'`, the machine (`wsl:<distro>`); absent is the default distribution. */
  hostId?: import('./execution-host').ExecutionHostId
}
export type InstalledSkillsResult =
  { ok: true; skills: InstalledSkill[]; diagnostics: string[] } | { ok: false; message: string }
export type InstalledSkillRemoveInput = InstalledSkillsInput & { installationId: string }
export type InstalledSkillRemoveResult = { ok: true } | { ok: false; message: string }
