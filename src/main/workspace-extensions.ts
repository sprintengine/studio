import type { AgentCapabilitiesInput, AgentCapabilitiesResult } from '../shared/skills'
import type { SkillSourcesResult, WorkspaceSkillsListInput, WorkspaceSkillsListResult } from '../shared/ipc/skills'
import type { WorkspaceExtensions } from '../shared/workspace-extensions'

/**
 * `workspace.extensions`' answer, from the readers the composer here uses: the
 * workspace skill inventory, the CLI's capability answer for its servers, and
 * the skill sources for the repository each installed skill came from. A
 * reader that fails leaves its half empty rather than failing the other.
 */
export function createWorkspaceExtensionsReader(deps: {
  listWorkspaceSkills(input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult>
  agentCapabilities(input: AgentCapabilitiesInput): Promise<AgentCapabilitiesResult>
  listSources(): Promise<SkillSourcesResult>
}): (workspaceRoot: string, cli: string | null) => Promise<WorkspaceExtensions> {
  return async (workspaceRoot, cli) => {
    const [listed, capabilities, sources] = await Promise.all([
      deps.listWorkspaceSkills({ workspaceRoot }).catch(() => null),
      cli ? deps.agentCapabilities({ workspaceRoot, pluginId: cli }).catch(() => null) : null,
      deps.listSources().catch(() => null),
    ])
    const repoOf = new Map(
      (sources?.ok ? sources.sources : [])
        .filter((source) => source.kind === 'github' && source.repo)
        .map((source) => [source.id, source.repo]),
    )
    const skills = (listed?.ok ? listed.skills : []).map(({ sourceId, ...skill }) => {
      const repo = sourceId ? repoOf.get(sourceId) : undefined
      return repo ? { ...skill, sourceRepo: repo } : skill
    })
    const servers = (capabilities?.ok ? (capabilities.servers ?? []) : []).map(
      ({ configPath: _path, ...server }) => server,
    )
    return { skills, servers }
  }
}
