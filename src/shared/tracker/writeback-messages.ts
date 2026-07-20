// Pure composition of the write-back comment bodies (MC-1640 / plan §3.7). The
// engine (T10) posts these verbatim through the provider's postComment, and the
// T11 settings preview renders the SAME functions so "what your team sees" can
// never drift from what is actually posted. Node-free so the renderer imports it
// directly. Plain, human, honest — no agent internals, no run-store jargon, and
// NEVER a secret. Side-effect-free so the exact wording is unit-testable alone.

// One trailing signature line so a reader on the tracker knows the comment came
// from Multicode's sprint automation rather than a person.
export const WRITEBACK_SIGNATURE = '— posted automatically by Multicode'

// Run started: the sprint that mirrors this issue has begun. `goal` is the run
// goal (the issue title for a seeded sprint), shown so the comment stands alone.
export function runStartedComment(input: { goal: string }): string {
  const goal = input.goal.trim()
  const lines = ['**Sprint started** in Multicode.']
  if (goal) lines.push('', `Working on: ${goal}`)
  lines.push('', WRITEBACK_SIGNATURE)
  return lines.join('\n')
}

// A pull request opened for this issue's sprint. Lists every project's PR link so
// a multi-repo run shows them all; callers pass only the URLs actually observed.
export function pullRequestComment(input: { goal: string; pullRequestUrls: string[] }): string {
  const urls = dedupeUrls(input.pullRequestUrls)
  const lines = [urls.length > 1 ? '**Pull requests opened** for this sprint.' : '**Pull request opened** for this sprint.']
  if (urls.length > 0) {
    lines.push('')
    for (const url of urls) lines.push(`- ${url}`)
  }
  lines.push('', WRITEBACK_SIGNATURE)
  return lines.join('\n')
}

// Run completed: every task landed. Includes the goal and any delivered pull
// request links so the closing comment is a self-contained summary.
export function runCompletedComment(input: { goal: string; pullRequestUrls: string[]; taskCount: number }): string {
  const goal = input.goal.trim()
  const urls = dedupeUrls(input.pullRequestUrls)
  const taskLabel = input.taskCount === 1 ? '1 task' : `${input.taskCount} tasks`
  const lines = ['**Sprint completed** in Multicode.']
  if (goal) lines.push('', `Goal: ${goal}`)
  lines.push('', `All ${taskLabel} finished.`)
  if (urls.length > 0) {
    lines.push('', urls.length > 1 ? 'Pull requests:' : 'Pull request:')
    for (const url of urls) lines.push(`- ${url}`)
  }
  lines.push('', WRITEBACK_SIGNATURE)
  return lines.join('\n')
}

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of urls ?? []) {
    const url = typeof raw === 'string' ? raw.trim() : ''
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}
