import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Default folder for a user's own skills. Created lazily the first time it is
 * offered as a local source destination — the app does not scatter empty
 * directories on install.
 */
export function defaultUserSkillsDir(homeDir: string = homedir()): string {
  return join(homeDir, '.multicode', 'skills')
}

export function ensureDefaultUserSkillsDir(homeDir: string = homedir()): string {
  const dir = defaultUserSkillsDir(homeDir)
  mkdirSync(dir, { recursive: true })
  return dir
}
