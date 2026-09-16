/**
 * How Sprint Engine managed agents are identified after `'sprintengine'`
 * left `AgentKind` (MC-2573, 2026-09-16).
 *
 * Roster agent ids are role ids (`architect`, `dev-1`) and cannot take a
 * namespace prefix without rewriting run.yaml. The module still claims
 * {@link SPRINT_ENGINE_AGENT_ID_PREFIX} via `registerAgentIdNamespace` for
 * unclaimed / future namespaced ids. In-workspace agents are identified by
 * roster membership (the run projection's `sprintEngineAgents` keys). Live
 * sessions are tagged `session.managed` by the launch contribution (MC-2567);
 * that tag lives on the main-process session, not on `AgentState`.
 *
 * Older persisted workspaces, the launch path, and the phone still emit
 * `kind: 'sprintengine'`. This helper is the only reader of that string;
 * nothing writes it.
 */
export const SPRINT_ENGINE_AGENT_ID_PREFIX = 'sprintengine-'

export function isSprintEngineManagedAgent(
  agent: { id?: string; kind?: string } | null | undefined,
  options?: { rosterIds?: Iterable<string>; agentId?: string },
): boolean {
  const id = options?.agentId ?? agent?.id
  if (id && id.startsWith(SPRINT_ENGINE_AGENT_ID_PREFIX)) return true
  if (id && options?.rosterIds) {
    for (const rosterId of options.rosterIds) {
      if (rosterId === id) return true
    }
  }
  return agent?.kind === 'sprintengine'
}

export function sprintEngineRosterAgentIds(
  sprintEngineAgents: Record<string, unknown> | null | undefined,
): string[] {
  return sprintEngineAgents ? Object.keys(sprintEngineAgents) : []
}
