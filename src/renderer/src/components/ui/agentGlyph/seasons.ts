import type { AgentCharacterId } from './characters'
import { stablePick } from './pick'

// Which characters are about depends on the time of year. The robot is in every
// pool, so an agent is never a stranger, and every pool holds at least three so
// agents running side by side usually differ.
export type AgentSeason = 'everyday' | 'halloween' | 'christmas'

export const AGENT_SEASON_POOLS: Record<AgentSeason, readonly AgentCharacterId[]> = {
  everyday: ['robot', 'blob', 'balloon', 'bear', 'gent', 'mushroom'],
  halloween: ['robot', 'pumpkin', 'ghost', 'cat', 'witch', 'skull'],
  christmas: ['robot', 'elf', 'santa', 'reindeer', 'present'],
}

/** The season a local date falls in: October is Halloween, 1–26 December Christmas. */
export function seasonFor(date: Date): AgentSeason {
  const month = date.getMonth() + 1
  if (month === 10) return 'halloween'
  if (month === 12 && date.getDate() <= 26) return 'christmas'
  return 'everyday'
}

// Set `sprintengine.agentSeason` in localStorage to see another season's
// characters without changing the clock.
const SEASON_OVERRIDE_KEY = 'sprintengine.agentSeason'

function seasonOverride(): AgentSeason | null {
  try {
    const value = globalThis.localStorage?.getItem(SEASON_OVERRIDE_KEY)
    return value === 'everyday' || value === 'halloween' || value === 'christmas' ? value : null
  } catch {
    return null
  }
}

// Today's season, read at most once a minute and never past midnight. Every
// glyph asks on every render, and lanes and cards re-render while agents
// stream, so the storage read and the date are not repeated for each. An
// override set from DevTools shows within the minute.
const SEASON_RECHECK_MS = 60_000
let today: { season: AgentSeason; until: number } | null = null

function currentSeason(now: number): AgentSeason {
  if (today && now < today.until) return today.season
  const date = new Date(now)
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
  today = { season: seasonOverride() ?? seasonFor(date), until: Math.min(midnight, now + SEASON_RECHECK_MS) }
  return today.season
}

/**
 * The character an agent appears as: stable for the agent within a season.
 * `date` asks about a particular day; without it, today's (cached) season.
 */
export function pickAgentCharacter(agentId: string, date?: Date): AgentCharacterId {
  const season = date ? (seasonOverride() ?? seasonFor(date)) : currentSeason(Date.now())
  return stablePick(agentId, AGENT_SEASON_POOLS[season])
}
