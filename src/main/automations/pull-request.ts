import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { AutomationDefinition } from '../../shared/automations/contracts'
import { runGitCommand } from '../git-utils'

const execFileAsync = promisify(execFile)

// App-side pull-request open for an agent-backed automation run. The user chose
// "worktree + branch convention, app opens the PR": the agent works in a per-run
// worktree on its own branch; on finalize the app backstop-commits any
// uncommitted work, pushes the branch, and opens (or reuses) a PR via the GitHub
// CLI. Failure is explicit (Fallback Discipline): a missing/unauthenticated `gh`,
// no remote, or no changes returns a reason instead of faking a PR link — the run
// still completes, just without a linked PR.

export type AutomationPullRequestResult =
  | { ok: true; url: string; created: boolean }
  // `withheldChanges` marks the review_only safeguard: a non-empty working diff
  // was found and deliberately not staged/committed/pushed (vs an ordinary
  // "could not link a PR" reason like a missing `gh`).
  | { ok: false; reason: string; withheldChanges?: boolean }

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
  /**
   * Run autonomy mode. `review_only` runs must never publish unexpected writes:
   * a non-empty working diff is refused (not staged/committed/pushed) instead of
   * being backstop-committed. The git-excluded run-status signal file never
   * appears in the working diff, so a clean review_only run still finalizes.
   */
  autonomy: AutomationDefinition['autonomyDefault']
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

  // review_only safeguard: a review_only run is not expected to change code, so a
  // non-empty working diff (the run-status signal file is git-excluded and never
  // appears here) is an anomaly. Refuse to stage/commit/push it and surface it,
  // independent of the CLI permission preset — the guard holds even if the preset
  // is misconfigured to permit writes.
  if (input.autonomy === 'review_only' && hasWorkingDiff) {
    return {
      ok: false,
      reason: 'review_only run left unexpected uncommitted changes; they were not staged, committed, or pushed.',
      withheldChanges: true,
    }
  }

  if (hasWorkingDiff) {
    const add = await deps.runGit(worktreePath, ['add', '-A'])
    if (!add.ok) return { ok: false, reason: commandReason('stage changes', add) }
    const commit = await deps.runGit(worktreePath, [
      'commit',
      '-m',
      input.commitMessage?.trim() || input.title,
    ])
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

async function runGhCommand(cwd: string, args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string; code?: string }
    const missing = execError.code === 'ENOENT'
    return {
      ok: false,
      stdout: execError.stdout ?? '',
      stderr: missing
        ? 'the GitHub CLI (gh) is not installed or not on PATH'
        : execError.stderr ?? execError.message ?? 'gh command failed',
    }
  }
}

export const defaultPullRequestDeps: PullRequestDeps = {
  runGit: (cwd, args) => runGitCommand(cwd, args).then((result) => ({
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
  })),
  runGh: runGhCommand,
}
