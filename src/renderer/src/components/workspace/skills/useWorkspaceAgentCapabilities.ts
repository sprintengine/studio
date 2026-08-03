import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentCapabilitiesResult } from '../../../../../shared/skills'
import type {
  CapabilityServer,
  CapabilitySnapshot,
} from './skillsPaneModel'

type SuccessfulCapabilities = Extract<AgentCapabilitiesResult, { ok: true }>

export type WorkspaceAgentCapabilitiesState = {
  snapshot: CapabilitySnapshot | null
  loading: boolean
  unavailableMessage: string | null
}

const IDLE: WorkspaceAgentCapabilitiesState = {
  snapshot: null,
  loading: false,
  unavailableMessage: null,
}

const NO_WORKSPACE = 'Open a project folder to see workspace skills and MCP servers.'

/**
 * Merge the capability answers for every CLI represented by this workspace.
 * Skills and servers are keyed by identity, while their CLI attribution is a
 * union. The click action is deliberately not part of this snapshot: it still
 * targets the last focused agent session.
 */
export function mergeWorkspaceAgentCapabilities(
  answers: Array<{ pluginId: string; result: SuccessfulCapabilities }>,
): CapabilitySnapshot {
  const skills = new Map<string, SuccessfulCapabilities['skills'][number]>()
  const servers = new Map<string, CapabilityServer>()
  const diagnostics = new Map<string, SuccessfulCapabilities['diagnostics'][number]>()
  const harnessIds = new Set<string>()
  const supports = new Set<SuccessfulCapabilities['support']>()

  for (const { pluginId, result } of answers) {
    supports.add(result.support)
    if (result.harnessId) harnessIds.add(result.harnessId)

    for (const skill of result.skills) {
      const existing = skills.get(skill.id)
      if (!existing) {
        skills.set(skill.id, { ...skill, pluginIds: [...new Set(skill.pluginIds)] })
        continue
      }
      existing.pluginIds = [...new Set([...existing.pluginIds, ...skill.pluginIds])].sort()
      if (!existing.description && skill.description) existing.description = skill.description
      if (!existing.name && skill.name) existing.name = skill.name
    }

    for (const server of result.servers) {
      const existing = servers.get(server.id)
      if (!existing) {
        servers.set(server.id, {
          ...server,
          pluginIds: [pluginId],
          configPaths: [server.configPath],
        })
        continue
      }
      existing.pluginIds = [...new Set([...(existing.pluginIds ?? []), pluginId])].sort()
      existing.configPaths = [
        ...new Set([...(existing.configPaths ?? [existing.configPath]), server.configPath]),
      ]
      // A count is only shown when every copy agrees. Conflicting or absent
      // declarations are not added together and presented as a guessed total.
      if (existing.toolCount !== server.toolCount) delete existing.toolCount
      if (existing.scope !== server.scope) existing.scope = 'workspace'
    }

    for (const diagnostic of result.diagnostics) {
      const key = [
        diagnostic.capability,
        diagnostic.reason,
        diagnostic.path,
        diagnostic.message,
      ].join('\u0000')
      diagnostics.set(key, diagnostic)
    }
  }

  const support = supports.has('native')
    ? 'native'
    : supports.has('prompt-shim')
      ? 'prompt-shim'
      : 'unsupported'
  const sortedHarnessIds = [...harnessIds].sort()

  return {
    support,
    harnessId: sortedHarnessIds[0] ?? '',
    harnessIds: sortedHarnessIds,
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
    servers: [...servers.values()].sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: [...diagnostics.values()],
  }
}

export function useWorkspaceAgentCapabilities(
  workspaceRoot: string | null,
  pluginIds: readonly string[],
): WorkspaceAgentCapabilitiesState & { refetch: () => void } {
  const [state, setState] = useState<WorkspaceAgentCapabilitiesState>(IDLE)
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((value) => value + 1), [])
  const normalizedPluginIds = [...new Set(pluginIds.filter(Boolean))].sort()
  const pluginKey = normalizedPluginIds.join('\u0000')

  const pluginIdsRef = useRef(normalizedPluginIds)
  pluginIdsRef.current = normalizedPluginIds

  const target = workspaceRoot ? `${workspaceRoot}::${pluginKey}` : null
  const [shownTarget, setShownTarget] = useState<string | null>(target)
  if (shownTarget !== target) {
    setShownTarget(target)
    setState({ snapshot: null, loading: target !== null, unavailableMessage: null })
  }

  useEffect(() => {
    if (!workspaceRoot) return
    void window.api.agentCapabilitiesWatchStart({ workspaceRoot }).catch(() => {})
    return () => {
      void window.api.agentCapabilitiesWatchStop({ workspaceRoot }).catch(() => {})
    }
  }, [workspaceRoot])

  useEffect(() => {
    if (!workspaceRoot) return
    return window.api.onAgentCapabilitiesInvalidated((event) => {
      if (event.workspaceRoot !== workspaceRoot) return
      const represented = new Set(pluginIdsRef.current)
      if (!event.pluginIds.some((pluginId) => represented.has(pluginId))) return
      refetch()
    })
  }, [refetch, workspaceRoot])

  useEffect(() => {
    if (!workspaceRoot) return
    let cancelled = false
    setState((previous) => ({ ...previous, loading: true, unavailableMessage: null }))

    Promise.all(
      normalizedPluginIds.map(async (pluginId) => ({
        pluginId,
        result: await window.api.agentCapabilities({ workspaceRoot, pluginId }),
      })),
    )
      .then((results) => {
        if (cancelled) return
        const failed = results.find(({ result }) => !result.ok)
        if (failed && !failed.result.ok) {
          setState({ snapshot: null, loading: false, unavailableMessage: failed.result.message })
          return
        }
        const answers = results.flatMap(({ pluginId, result }) =>
          result.ok ? [{ pluginId, result }] : [],
        )
        setState({
          snapshot: mergeWorkspaceAgentCapabilities(answers),
          loading: false,
          unavailableMessage: null,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          snapshot: null,
          loading: false,
          unavailableMessage:
            error instanceof Error ? error.message : 'Could not read workspace capabilities.',
        })
      })

    return () => {
      cancelled = true
    }
    // pluginKey is the stable identity for the normalized ids; depending on the
    // array itself would refetch on every render.
  }, [nonce, pluginKey, workspaceRoot])

  if (!workspaceRoot) {
    return { snapshot: null, loading: false, unavailableMessage: NO_WORKSPACE, refetch }
  }
  return { ...state, refetch }
}
