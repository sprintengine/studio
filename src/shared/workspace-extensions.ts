import type { WorkspaceSkill } from './ipc/skills'
import type { AgentMcpServer } from './skills'

/**
 * What a chat in one project folder can use, as `workspace.extensions`
 * answers it to a paired machine: the folder's skills, each with the GitHub
 * repository a skill source installed it from, and the MCP servers the chat's
 * CLI is configured with there, with the connection each last reported. No
 * path on the answering machine is in it.
 */
export type WorkspaceExtensions = {
  skills: WorkspaceSkill[]
  servers: Array<Omit<AgentMcpServer, 'configPath'>>
}
