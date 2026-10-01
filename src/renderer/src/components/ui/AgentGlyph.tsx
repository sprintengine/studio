import type { JSX } from 'react'
import type { TooltipChildProps } from './Tooltip'
import { AGENT_CHARACTERS, doneEyes, failedEyes, stoppedEyes, type AgentCharacterId } from './agentGlyph/characters'
import { pickAgentCharacter } from './agentGlyph/seasons'

// A spawned agent drawn as a small character: working while its agent runs
// (it moves; reduced motion holds it still), content when it is done, crossed
// out when it failed, switched off when it was stopped. Which character is
// picked from the season's pool by the agent's id, so an agent keeps its face
// for as long as it is on screen.

export type AgentGlyphState = 'working' | 'done' | 'failed' | 'stopped' | 'unknown'

const TONE: Record<AgentGlyphState, string> = {
  working: 'text-[color:var(--accent-primary)]',
  done: 'text-[color:var(--text-subtle)]',
  failed: 'text-[color:var(--tone-error)]',
  stopped: 'text-[color:var(--text-subtle)]',
  unknown: 'text-[color:var(--text-subtle)]',
}

export function AgentGlyph({
  agentId,
  state,
  character,
  label,
  className,
  ...rest
}: {
  /** What the character is picked by: the id of the call that spawned the agent. */
  agentId: string
  state: AgentGlyphState
  /** A specific character instead of the season's pick (previews, tests). */
  character?: AgentCharacterId
  /** Accessible name; omit when adjacent text already names the agent and its state. */
  label?: string
  className?: string
} & Partial<TooltipChildProps>): JSX.Element {
  const id = character ?? pickAgentCharacter(agentId)
  const drawing = AGENT_CHARACTERS[id]
  const a11y = label ? ({ role: 'img', 'aria-label': label } as const) : ({ 'aria-hidden': true } as const)
  const face =
    state === 'working' ? null : state === 'failed' ? (
      failedEyes(drawing.eyes, drawing.crossSize)
    ) : state === 'stopped' ? (
      stoppedEyes(drawing.eyes)
    ) : (
      <>
        {doneEyes(drawing.eyes)}
        {drawing.doneExtra}
      </>
    )
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      {...a11y}
      {...rest}
      data-character={id}
      // A working character moves as a whole on the root <svg> (a CSS box, so
      // the compositor runs it) and only its small parts inside (index.css).
      className={`agent-glyph agent-glyph--${id} agent-glyph--${state} ${state === 'working' ? 'agent-glyph__whole ' : ''}icon-sm shrink-0 overflow-visible ${TONE[state]} ${className ?? ''}`}
    >
      {state === 'working' ? (
        <>
          {drawing.body}
          {drawing.working}
        </>
      ) : (
        <>
          {drawing.body}
          {drawing.rest}
          {face}
        </>
      )}
    </svg>
  )
}
