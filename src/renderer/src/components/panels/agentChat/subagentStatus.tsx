// Where a spawned agent stands, as its lane and the Agents panel show it: the
// glyph beside it and the words that say working, done, failed or stopped.

import type { JSX } from 'react'
import { AgentGlyph, WorkingMark, type AgentGlyphState } from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { TranscriptToolEntry } from './conversationProjection'
import { formatStepDuration } from './stepDuration'
import { ToolKindGlyph } from './toolRows/ToolKindGlyph'

/** The glyph state of the agent a lane spawned. */
export function laneAgentState(tool: TranscriptToolEntry): AgentGlyphState {
  if (tool.status === 'running') return 'working'
  if (tool.agent?.state === 'failed' || tool.outputStatus === 'error') return 'failed'
  if (tool.agent?.state === 'stopped' || tool.outputStatus === 'stopped' || tool.outputStatus === 'declined')
    return 'stopped'
  if (tool.agent?.state === 'unknown') return 'unknown'
  return 'done'
}

/** How long the agent ran: from its spawn to its end, or what it reported. */
export function laneDurationMs(tool: TranscriptToolEntry): number | undefined {
  if (tool.startedAt !== undefined && tool.completedAt !== undefined)
    return Math.max(0, tool.completedAt - tool.startedAt)
  return tool.agent?.usage?.durationMs || undefined
}

/**
 * How a settled agent ended, in words: "Done in 1m 29s", "Failed after 9s",
 * "Stopped", or "Ran in the background" for one whose end was never recorded.
 * Undefined while it runs, when the caller shows the live elapsed time.
 */
export function laneOutcomeWords(tool: TranscriptToolEntry): string | undefined {
  const state = laneAgentState(tool)
  if (state === 'working') return undefined
  if (state === 'unknown') return 'Ran in the background'
  const duration = laneDurationMs(tool)
  const took = duration !== undefined ? formatStepDuration(duration) : undefined
  if (tool.outputStatus === 'declined') return 'Declined'
  if (state === 'failed') return took ? `Failed after ${took}` : 'Failed'
  if (state === 'stopped') return took ? `Stopped after ${took}` : 'Stopped'
  return took ? `Done in ${took}` : 'Done'
}

/**
 * The mark beside an agent: its character, or, with characters turned off in
 * Settings, the working mark while it runs and the agent kind glyph after.
 */
export function LaneGlyph({ tool, className }: { tool: TranscriptToolEntry; className?: string }): JSX.Element {
  const characters = useWorkspaceStore((state) => state.appSettings.appearance.agentCharacters)
  return <LaneMark tool={tool} characters={characters} className={className} />
}

export function LaneMark({
  tool,
  characters,
  className,
}: {
  tool: TranscriptToolEntry
  characters: boolean
  className?: string
}): JSX.Element {
  const state = laneAgentState(tool)
  if (characters) return <AgentGlyph agentId={tool.id} state={state} className={className} />
  if (state === 'working') return <WorkingMark label="Agent working" seed={tool.id} className={className} />
  const ink = state === 'failed' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-subtle)]'
  return (
    <span className={`flex shrink-0 ${ink} ${className ?? ''}`}>
      <ToolKindGlyph kind="subagent" />
    </span>
  )
}
