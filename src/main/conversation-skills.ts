import { readFile, stat } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import type { ConversationSkillRef, ConversationCapabilities } from '../shared/conversation-runtime'
import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../shared/skill-harnesses'
import { createWorkspaceSkillsService } from './workspace-skills-service'
import { createAgentSkillInstaller } from './agent-skill-installer'

export type ResolvedConversationSkills = { ids: string[]; context?: string }
export type ConversationSkillsResolver = (input: {
  workspaceRoot: string
  skills: ConversationSkillRef[]
  mode: ConversationCapabilities['skills']
}) => Promise<ResolvedConversationSkills>

/** Resolve the same workspace inventory and installer used by skill chips. */
export function createConversationSkillsResolver(
  options: {
    inventory?: ReturnType<typeof createWorkspaceSkillsService>
    installer?: Pick<ReturnType<typeof createAgentSkillInstaller>, 'attach'>
  } = {},
): ConversationSkillsResolver {
  const inventory = options.inventory ?? createWorkspaceSkillsService()
  const installer = options.installer ?? createAgentSkillInstaller()
  return async ({ workspaceRoot, skills, mode }) => {
    if (skills.length === 0) return { ids: [] }
    if (mode === 'none') throw new Error('This conversation provider does not support attached skills.')
    const listed = await inventory.listWorkspaceSkills({ workspaceRoot })
    if (!listed.ok) throw new Error(listed.message)
    const ids: string[] = []
    const sections: string[] = []
    let totalBytes = 0
    for (const skill of skills) {
      if (!/^[\w.-]+(?::[\w.-]+)?$/.test(skill.id) || skill.id === '.' || skill.id === '..')
        throw new Error('Attached skill identity is invalid.')
      if (ids.includes(skill.id)) continue
      const known = listed.skills.find((entry) => entry.id === skill.id)
      if (mode === 'native') {
        const installed = join(workspaceRoot, '.claude', 'skills', skill.id, 'SKILL.md')
        if (!(await isFile(installed))) {
          const attached = await installer.attach({ workspaceRoot, skillId: skill.id })
          if (!attached.ok) throw new Error(`Could not attach ${skill.id}: ${attached.message}`)
          if (!(await isFile(installed)))
            throw new Error(`Skill ${skill.id} could not be installed for this conversation.`)
        }
      } else {
        let source: string | undefined
        if (skill.sourcePath) {
          const candidate = resolve(workspaceRoot, skill.sourcePath)
          source = basename(candidate) === 'SKILL.md' ? candidate : join(candidate, 'SKILL.md')
        } else if (known) {
          for (const harness of SKILL_PACK_HARNESSES) {
            const candidate = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills', skill.id, 'SKILL.md')
            if (await isFile(candidate)) {
              source = candidate
              break
            }
          }
        }
        if (!source || !(await isFile(source))) throw new Error(`Skill ${skill.id} is not available in this workspace.`)
        const size = (await stat(source)).size
        if (size > 24 * 1024) throw new Error(`Skill ${skill.id} exceeds the 24 KB instructions limit.`)
        const body = await readFile(source, 'utf8')
        totalBytes += Buffer.byteLength(body)
        if (totalBytes > 64 * 1024) throw new Error(`Skill ${skill.id} exceeds the 64 KB total instructions budget.`)
        sections.push(`Attached skill: ${skill.id}\nSource directory: ${dirname(source)}\n${body}`)
      }
      ids.push(skill.id)
    }
    return { ids, ...(sections.length ? { context: sections.join('\n\n') } : {}) }
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
