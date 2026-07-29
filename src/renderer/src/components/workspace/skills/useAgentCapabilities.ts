import { useCallback, useEffect, useRef, useState } from 'react'

import type { CapabilitySnapshot } from './skillsPaneModel'

// One question, asked once, kept true.
//
// The pane asks `agentCapabilities` and renders what comes back. It does not
// join the skills read and the MCP read itself — that resolution lives in the
// main process precisely so no surface can drift from the next one.
//
// Freshness is an invalidation, never a push: main says only *that* the paths it
// resolved changed, and the answer comes back through this same query. A pushed
// list would be a second source of truth for it. The watch is refcounted in
// main, so this hook must stop what it starts or the watchers outlive the pane.

export type AgentCapabilitiesState = {
  snapshot: CapabilitySnapshot | null
  loading: boolean
  /** Set when the question could not be asked at all — no workspace open. */
  unavailableMessage: string | null
}

const IDLE: AgentCapabilitiesState = { snapshot: null, loading: false, unavailableMessage: null }

const NO_WORKSPACE = 'Open a project folder to see this agent’s skills.'

export function useAgentCapabilities(
  workspaceRoot: string | null,
  pluginId: string | null,
): AgentCapabilitiesState & { refetch: () => void } {
  const [state, setState] = useState<AgentCapabilitiesState>(IDLE)
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((value) => value + 1), [])

  // The invalidation handler is registered once per workspace and needs the
  // current CLI without re-subscribing on every tab switch.
  const pluginIdRef = useRef(pluginId)
  pluginIdRef.current = pluginId

  // Which agent the state in hand describes. A new target drops the old answer:
  // showing the previous agent's skills under the new tab's name would be
  // live-looking and wrong.
  //
  // Reset during render, not in an effect. An effect runs after this render has
  // committed, so the pane would paint one frame of the previous agent's list
  // under the newly focused tab before blanking it — the exact "renders what the
  // resolver did not return for this agent" defect, just brief.
  const target = workspaceRoot && pluginId ? `${workspaceRoot}::${pluginId}` : null
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
      // `pluginIds` is the addressable identity: a CLI can declare an MCP config
      // and no skill integration at all, so it has no harness id to match on.
      const current = pluginIdRef.current
      if (!current || !event.pluginIds.includes(current)) return
      refetch()
    })
  }, [refetch, workspaceRoot])

  useEffect(() => {
    if (!workspaceRoot || !pluginId) return
    let cancelled = false
    // A refetch of the *same* target keeps the list on screen, so an
    // invalidation moves the pane once instead of flashing a spinner over a list
    // that is about to come back almost identical. The cross-target reset
    // already happened during render.
    setState((previous) => ({ ...previous, loading: true, unavailableMessage: null }))
    window.api
      .agentCapabilities({ workspaceRoot, pluginId })
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setState({ snapshot: null, loading: false, unavailableMessage: result.message })
          return
        }
        setState({
          snapshot: {
            support: result.support,
            harnessId: result.harnessId,
            skills: result.skills,
            servers: result.servers,
            diagnostics: result.diagnostics,
          },
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
            error instanceof Error ? error.message : 'Could not read this agent’s capabilities.',
        })
      })
    return () => {
      cancelled = true
    }
  }, [nonce, pluginId, workspaceRoot])

  // Derived, never stored: with no project folder there is nothing to ask, and a
  // stored message would need clearing on the way back out.
  if (!workspaceRoot) return { snapshot: null, loading: false, unavailableMessage: NO_WORKSPACE, refetch }
  return { ...state, refetch }
}
