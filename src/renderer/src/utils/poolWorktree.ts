import type { WorktreePoolDepsState, WorktreePoolLeaseOwner } from '../../../shared/electron-api'
import { publishDiagnosticSync } from './diagnostics'
import { agentWorktreePaths } from './workspaceWorktree'

/**
 * An agent worktree, from the pool when a warm slot is ready and made fresh
 * when not.
 *
 * The pool (main's worktree-pool) keeps a few worktrees per repository checked
 * out at the default branch with their dependencies installed; a lease puts one
 * on `agent/<slug>` in a few git calls. Anything that stops a lease — the pool
 * is off, nothing is warm yet, the agent runs on a WSL machine, another Studio
 * holds the pool — falls through to the create path every worktree agent used before,
 * so asking for a worktree never fails because of the pool.
 */

export type AgentWorktree = {
  path: string
  branch: string
  /** Set when the worktree is a pool slot; it becomes part of the worktree's identity. */
  leaseId: string | null
  /** The ref the worktree started from. */
  baseRef: string
  pooled: boolean
  elapsedMs: number
}

function depsBanner(depsState: WorktreePoolDepsState, installCommand: string | null, path: string): void {
  if (depsState !== 'failed') return
  publishDiagnosticSync({
    level: 'warning',
    source: 'workspace',
    title: 'Dependencies not installed in this worktree',
    message: `${installCommand ?? 'The install'} failed in ${path}. The agent may need to run it before tests pass; the Worktree manager shows the error.`,
  })
}

export async function leaseOrCreateAgentWorktree(input: {
  repoRoot: string
  name: string
  owner: WorktreePoolLeaseOwner
  /**
   * The machine the agent runs on (the workspace's, or the one New chat picked).
   * The pool serves this machine's own git only; a WSL machine is declined and
   * its worktree is made by that machine's git, as before.
   */
  hostId: string | null
}): Promise<{ ok: true; worktree: AgentWorktree } | { ok: false; message: string }> {
  const started = performance.now()
  const paths = agentWorktreePaths(input.repoRoot, input.name)
  if (!paths) return { ok: false, message: `"${input.name}" does not reduce to a usable worktree name.` }

  if (typeof window.api.leasePoolWorktree === 'function') {
    const leased = await window.api
      .leasePoolWorktree({ repoRoot: input.repoRoot, name: input.name, owner: input.owner, hostId: input.hostId })
      .catch(() => null)
    if (leased?.ok) {
      const elapsedMs = Math.round(performance.now() - started)
      console.info(`[worktree] leased ${leased.slotId} on ${leased.branch} in ${elapsedMs} ms`)
      depsBanner(leased.depsState, leased.installCommand, leased.path)
      return {
        ok: true,
        worktree: {
          path: leased.path,
          branch: leased.branch,
          leaseId: leased.leaseId,
          baseRef: leased.baseRef ?? 'HEAD',
          pooled: true,
          elapsedMs,
        },
      }
    }
    if (leased) console.info(`[worktree] no pooled worktree (${leased.reason}): creating one`)
  }

  const created = await window.api.createGitWorktree({
    repoRoot: input.repoRoot,
    containerPath: paths.containerPath,
    destinationPath: paths.destinationPath,
    branchName: paths.branchName,
    baseRef: 'HEAD',
    copyIncludedFiles: true,
    ...(input.hostId ? { hostId: input.hostId } : {}),
  })
  if (!created.ok) return { ok: false, message: created.message }
  const elapsedMs = Math.round(performance.now() - started)
  console.info(`[worktree] created ${created.data.path} in ${elapsedMs} ms`)
  return {
    ok: true,
    worktree: {
      path: created.data.path,
      branch: created.data.branch ?? paths.branchName,
      leaseId: null,
      baseRef: 'HEAD',
      pooled: false,
      elapsedMs,
    },
  }
}
