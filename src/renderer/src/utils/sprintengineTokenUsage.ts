import type {
  SprintEngineTokenCoverage,
  SprintEngineTokenUsageReport,
} from '../../../shared/sprintengine-token-usage'

// Presentation helpers for Sprint Engine token accounting. Numbers stay
// honest: totals are token counts (never dollars), and every headline carries
// its coverage so an unmeasured agent can never silently shrink the figure.

// Compact token count for tiles and inline labels: 950, 12.3k, 1.23M, 4.5B.
// Unit selection uses the ROUNDED value so a figure just under a boundary
// (e.g. 999,960) promotes to "1M" instead of rendering a malformed "1000k".
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1_000) return String(Math.round(value))
  const kilo = value / 1_000
  if (Number(kilo.toFixed(1)) < 1_000) return `${trimTrailingZero(kilo.toFixed(1))}k`
  const mega = value / 1_000_000
  if (Number(mega.toFixed(2)) < 1_000) return `${trimTrailingZero(mega.toFixed(2))}M`
  return `${trimTrailingZero((value / 1_000_000_000).toFixed(2))}B`
}

function trimTrailingZero(fixed: string): string {
  return fixed.replace(/\.?0+$/, '')
}

// Plain-language coverage caveat: null when every agent was measured (no
// caveat needed), otherwise e.g. "Measured 4 of 6 agents; 2 ran on CLIs
// without readable token data (opencode)."
export function describeTokenCoverage(coverage: SprintEngineTokenCoverage): string | null {
  const totalAgents = coverage.measuredAgents + coverage.unmeasuredAgents
  if (coverage.unmeasuredAgents === 0) return null
  if (coverage.measuredAgents === 0) {
    return 'No token usage could be measured for this run’s agents.'
  }
  const clis = [...new Set(coverage.unmeasured.map((entry) => entry.cli).filter(Boolean))]
  const cliNote = clis.length > 0 ? ` (${clis.join(', ')})` : ''
  return `Measured ${coverage.measuredAgents} of ${totalAgents} agents; ${coverage.unmeasuredAgents} ran on CLIs without readable token data${cliNote}.`
}

// True when the report has anything worth rendering: at least one agent
// (measured or not). An empty report (no ledger, no roster — e.g. a run that
// never spawned agents) renders no token section at all.
export function tokenReportHasAgents(report: SprintEngineTokenUsageReport | null): boolean {
  return Boolean(report && report.perAgent.length > 0)
}
