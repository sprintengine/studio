// Where a spawned agent stands, as its lane and the Agents panel show it: the
// glyph beside it and the words that say working, done, failed or stopped.

import { createContext, useContext, type JSX } from 'react'
import { AgentGlyph, WorkingMark, type AgentGlyphState } from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { TranscriptToolEntry } from './conversationProjection'
import { flattenToolEntries, subagentLaneLabel, toolObject } from './conversationTimeline'
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

/**
 * What the agent was sent to do: the spawning call's summary, else the short
 * description the call gave it (the model writes one for every agent), else
 * the one the agent reported when it started.
 */
export function laneTask(tool: TranscriptToolEntry): string {
  const summary = toolObject(tool)
  if (summary) return summary
  const input = tool.input
  const described =
    input && typeof input === 'object' && !Array.isArray(input) && typeof input.description === 'string'
      ? input.description.trim()
      : ''
  return described || tool.agent?.description || ''
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

// What each kind of agent is for, as the session's provider described them
// ('Explore' → "Fast agent specialized for exploring codebases…"). Provided
// by the chat around its timeline.
const SubagentTypesContext = createContext<Record<string, string>>({})
export const SubagentTypesProvider = SubagentTypesContext.Provider

// Said for the agents every Claude session has, when the session has not (yet)
// described them itself.
const BUILT_IN_AGENT_TYPES: Record<string, string> = {
  Explore: 'A read-only helper that searches the code and reports back.',
  Plan: 'A read-only helper that works out an approach before anything changes.',
  'general-purpose': 'A helper that takes on part of the task in parallel, with the same tools as the main agent.',
}

/** What an agent of this type is for, in a sentence, when anything says. */
export function useSubagentTypeDescription(type: string | undefined): string | undefined {
  const described = useContext(SubagentTypesContext)
  if (!type) return undefined
  const text = described[type] ?? BUILT_IN_AGENT_TYPES[type]
  if (!text) return undefined
  // A provider's description is written for the model choosing an agent and
  // runs long; its first sentence says what the agent is.
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/u.exec(text.trim())?.[0] ?? text.trim()
  return sentence.length > 180 ? `${sentence.slice(0, 179).trimEnd()}…` : sentence
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k tokens` : `${count} tokens`
}

/**
 * The card an agent's glyph and name open on hover: which agent, how it is
 * doing, what it was sent to do, what kind of helper it is, and what it is
 * doing right now or why it ended.
 */
export function AgentCardContent({ tool, running }: { tool: TranscriptToolEntry; running: boolean }): JSX.Element {
  const description = useSubagentTypeDescription(tool.subagentType)
  const task = laneTask(tool)
  const outcome = laneOutcomeWords(tool)
  const now = tool.agent?.progressSummary ?? (tool.agent?.lastToolName ? `Using ${tool.agent.lastToolName}` : undefined)
  const steps = tool.agent?.usage?.toolUses ?? flattenToolEntries(tool.children ?? []).length
  const tokens = tool.agent?.usage?.totalTokens
  const footer = [steps ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : null, tokens ? formatTokens(tokens) : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <>
      <span className="block font-medium text-[color:var(--text-strong)]">
        {subagentLaneLabel(tool)} · {running ? 'Working' : outcome}
      </span>
      {task ? <span className="block text-[color:var(--text-default)]">{task}</span> : null}
      {description ? <span className="block">{description}</span> : null}
      {running && now ? <span className="block">Now: {now}</span> : null}
      {!running && tool.agent?.error ? (
        <span className="block text-[color:var(--tone-error)]">{tool.agent.error}</span>
      ) : null}
      {footer ? <span className="block text-[color:var(--text-subtle)]">{footer}</span> : null}
    </>
  )
}
