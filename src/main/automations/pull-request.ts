import { runGitCommand } from '../git-utils'
import { sharedGhRunner, type GhRunner } from '../github/gh'

// App-side pull-request open for an agent-backed automation run. The user chose
// "worktree + branch convention, app opens the PR": the agent works in a per-run
// worktree on its own branch; on finalize the app backstop-commits any
// uncommitted work, pushes the branch, and opens (or reuses) a PR via the GitHub
// CLI. Failure is explicit (Fallback Discipline): a missing/unauthenticated `gh`,
// no remote, or no changes returns a reason instead of faking a PR link — the run
// still completes, just without a linked PR.

export type AutomationPullRequestResult = { ok: true; url: string; created: boolean } | { ok: false; reason: string }

export type CommandResult = { ok: boolean; stdout: string; stderr: string }

export type PullRequestDeps = {
  runGit: (cwd: string, args: string[]) => Promise<CommandResult>
  runGh: (cwd: string, args: string[]) => Promise<CommandResult>
}

export type OpenAutomationRunPullRequestInput = {
  worktreePath: string
  branch: string
  title: string
  body: string
  /** Backstop commit message used when the agent left uncommitted work. */
  commitMessage?: string
}

export async function openAutomationRunPullRequest(
  input: OpenAutomationRunPullRequestInput,
  deps: PullRequestDeps = defaultPullRequestDeps,
): Promise<AutomationPullRequestResult> {
  const { worktreePath, branch } = input

  // 1. Backstop-commit any uncommitted work the agent left in the worktree.
  const status = await deps.runGit(worktreePath, ['status', '--porcelain'])
  if (!status.ok) return { ok: false, reason: commandReason('read git status', status) }
  const hasWorkingDiff = status.stdout.trim().length > 0

  // Every run may backstop-commit its diff: a working diff on the run's own
  // branch is the expected output, not an anomaly. The containment is the
  // per-run worktree, the per-run branch, and a pull request nothing merges
  // automatically — not a mode that told the agent to write nothing.
  if (hasWorkingDiff) {
    const add = await deps.runGit(worktreePath, ['add', '-A'])
    if (!add.ok) return { ok: false, reason: commandReason('stage changes', add) }
    const commit = await deps.runGit(worktreePath, ['commit', '-m', input.commitMessage?.trim() || input.title])
    if (!commit.ok) return { ok: false, reason: commandReason('commit changes', commit) }
  }

  // 2. Push the branch so a PR can reference it.
  const push = await deps.runGit(worktreePath, ['push', '-u', 'origin', branch])
  if (!push.ok) return { ok: false, reason: commandReason('push the run branch', push) }

  // 3. Reuse an existing PR for the branch (idempotent re-finalize).
  const existing = await deps.runGh(worktreePath, ['pr', 'view', branch, '--json', 'url', '-q', '.url'])
  if (existing.ok && existing.stdout.trim()) {
    return { ok: true, url: existing.stdout.trim(), created: false }
  }

  // 4. Otherwise open one. gh defaults the base to the repo's default branch.
  const created = await deps.runGh(worktreePath, [
    'pr',
    'create',
    '--head',
    branch,
    '--title',
    input.title,
    '--body',
    input.body,
  ])
  if (!created.ok) return { ok: false, reason: commandReason('open a pull request', created) }

  const url = firstUrl(created.stdout)
  if (url) return { ok: true, url, created: true }

  // gh did not print a URL — read it back rather than guessing.
  const view = await deps.runGh(worktreePath, ['pr', 'view', branch, '--json', 'url', '-q', '.url'])
  if (view.ok && view.stdout.trim()) return { ok: true, url: view.stdout.trim(), created: true }
  return { ok: false, reason: 'Opened a pull request but could not resolve its URL.' }
}

function commandReason(action: string, result: CommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim()
  return `Could not ${action}${detail ? `: ${detail}` : '.'}`
}

function firstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/u)
  return match ? match[0] : null
}

/**
 * This module's `gh` calls, on THE shared runner (`main/github/gh.ts`,
 * epic `pull-request-marks` decision 11). It used to spawn `gh` itself, without
 * the login-shell PATH retry, so a GUI-launched app with a Homebrew `gh` was
 * told the binary did not exist and every run finished without a pull request
 * link. Same Fallback Discipline as before — a missing or failing `gh` is a
 * REASON, never a faked PR — only now "missing" is the runner's `found: false`
 * rather than an ENOENT this module had to recognise on its own.
 */
export function createGhCommandRunner(gh: GhRunner) {
  return async (cwd: string, args: string[]): Promise<CommandResult> => {
    const result = await gh.run(args, { cwd })
    if (!result.found) {
      return { ok: false, stdout: '', stderr: 'the GitHub CLI (gh) is not installed or not on PATH' }
    }
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.code === 0 ? result.stderr : result.stderr.trim() || 'gh command failed',
    }
  }
}

const defaultPullRequestDeps: PullRequestDeps = {
  runGit: (cwd, args) =>
    runGitCommand(cwd, args).then((result) => ({
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr,
    })),
  runGh: createGhCommandRunner(sharedGhRunner()),
}
