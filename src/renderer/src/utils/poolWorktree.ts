import type { WorktreePoolDepsState, WorktreePoolLeaseOwner } from '../../../shared/electron-api'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { AgentCli } from '../types/workspace'
import { publishDiagnosticSync } from './diagnostics'
import { agentWorktreePaths } from './workspaceWorktree'

/**
 * An agent worktree, from the pool when a warm slot is ready and made fresh
 * when not.
 *
 * The pool (main's worktree-pool) keeps a few worktrees per repository checked
 * out at the default branch with their dependencies installed; a lease puts one
 * on `agent/<slug>` in a few git calls. Anything that stops a lease — the pool
 * is off, nothing is warm yet, the agent runs in WSL, another Studio holds the
 * pool — falls through to the create path every worktree agent used before,
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

/** The platform a CLI's agents run on: WSL when the person turned that on for it (Windows only). */
export function poolRuntimeFor(cli: AgentCli | null | undefined): 'native' | 'wsl' {
  if (!cli) return 'native'
  const runtime = useWorkspaceStore.getState().appSettings.cliRuntimes?.[cli]
  return runtime?.useWsl ? 'wsl' : 'native'
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
  runtime: 'native' | 'wsl'
}): Promise<{ ok: true; worktree: AgentWorktree } | { ok: false; message: string }> {
  const started = performance.now()
  const paths = agentWorktreePaths(input.repoRoot, input.name)
  if (!paths) return { ok: false, message: `"${input.name}" does not reduce to a usable worktree name.` }

  if (typeof window.api.leasePoolWorktree === 'function') {
    const leased = await window.api
      .leasePoolWorktree({ repoRoot: input.repoRoot, name: input.name, owner: input.owner, runtime: input.runtime })
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
