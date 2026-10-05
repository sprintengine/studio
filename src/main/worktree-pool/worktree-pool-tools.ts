import { toolError, toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import { workspaceProjectRootOf } from '../../shared/worktree-paths'
import type { WorktreePoolService } from './worktree-pool-service'

// The worktree pool's tools: how an agent that wants a worktree of its own
// gets one from the pool instead of running `git worktree add` itself (owner
// ruling 2026-10-05). A worktree an agent makes itself is a fresh checkout with
// nothing installed, forked from whatever its checkout is on, and nobody
// cleans it up; one leased here is on the default branch, keeps the last
// agent's dependencies, and goes back to the pool when the agent is gone.
//
// Whose lease it is comes from the CONNECTION, never from the arguments: the
// calling agent, which the gateway knows from the agent's launch. Anything
// else calling is refused, because a lease nobody owns is returned the moment
// the cleanup next looks.

export const WORKTREE_LEASE_TOOL = 'worktree.lease'
export const WORKTREE_RELEASE_TOOL = 'worktree.release'

/** The worktree-name rule `agentWorktreePaths` applies, said to the agent. */
const NAME_DESCRIPTION =
  'A short name for the work, e.g. "fix-login-redirect". The worktree is put on the branch `agent/<name>`; it ' +
  'must not exist yet.'

export type WorktreePoolToolsDeps = {
  pool: Pick<WorktreePoolService, 'lease' | 'release' | 'leaseAt'>
  /** The folder and project the calling agent's workspace is on, or null when the registry has no such workspace. */
  findWorkspace(workspaceId: string): { folderPath?: string | null; worktree?: { repoRoot?: string } | null } | null
}

function callingAgent(context: Parameters<McpToolRegistration['handler']>[1]) {
  const metadata = context?.metadata
  if (metadata?.kind !== 'studio-agent' || !metadata.workspaceId || !metadata.agentId) return null
  return { workspaceId: metadata.workspaceId, agentId: metadata.agentId }
}

const NOT_AN_AGENT =
  'Only an agent SprintEngine Studio started can lease a worktree: the worktree is held for that agent and goes ' +
  'back to the pool when the agent is gone.'

export function createWorktreePoolTools(deps: WorktreePoolToolsDeps): McpToolRegistration[] {
  return [
    {
      name: WORKTREE_LEASE_TOOL,
      description:
        'Get a git worktree of your own for this repository, on a new branch forked from the default branch ' +
        '(origin/main, fetched now). Use this instead of `git worktree add` whenever you want to work apart from ' +
        'the checkout you were started in. The worktree may be one an earlier agent used: it is clean and on the ' +
        "default branch, but its ignored files (node_modules, build output, a virtual environment) are that agent's. " +
        'Studio never installs dependencies, so run the project install yourself if they are missing or the ' +
        'lockfile changed. Work in the returned path; the worktree stays yours while you exist, and you can give ' +
        'it back early with worktree.release.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: NAME_DESCRIPTION },
        },
        required: ['name'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        const caller = callingAgent(context)
        if (!caller) return toolError('not_an_agent', NOT_AN_AGENT)
        if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 80) {
          return toolError('invalid_arguments', '"name" is a short name for the work, at most 80 characters.')
        }
        const workspace = deps.findWorkspace(caller.workspaceId)
        const repoRoot = workspace ? workspaceProjectRootOf(workspace) : null
        if (!repoRoot) {
          return toolError('no_repository', 'Your workspace has no project folder to make a worktree of.')
        }
        const leased = await deps.pool.lease({
          repoRoot,
          name: args.name.trim(),
          owner: caller.agentId,
          agentId: caller.agentId,
          copyIncludedFiles: true,
        })
        if (!leased.ok) {
          const code =
            leased.reason === 'branch-exists' || leased.reason === 'invalid-name'
              ? 'invalid_arguments'
              : leased.reason === 'not-a-repo' || leased.reason === 'no-base'
                ? 'no_repository'
                : 'unavailable'
          return toolError(code, leased.message)
        }
        return toolSuccess({
          path: leased.path,
          branch: leased.branch,
          baseRef: leased.baseRef,
          baseCommit: leased.baseSha,
          reused: !leased.created,
          dependencies:
            'Not installed by Studio. A reused worktree keeps the previous agent’s ignored files; run the install ' +
            'if they are missing or the lockfile changed.',
        })
      },
    },
    {
      name: WORKTREE_RELEASE_TOOL,
      description:
        'Give back a worktree you leased with worktree.lease, once you are done with it. Commit or push your work ' +
        'first: a worktree with uncommitted changes is held for the person to decide about, not reused. Your branch ' +
        'is kept either way. Leave the worktree directory before releasing it.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path worktree.lease returned.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        const caller = callingAgent(context)
        if (!caller) return toolError('not_an_agent', NOT_AN_AGENT)
        if (typeof args.path !== 'string' || !args.path.trim()) {
          return toolError('invalid_arguments', '"path" is the path worktree.lease returned.')
        }
        const lease = deps.pool.leaseAt(args.path.trim())
        if (!lease || lease.agentId !== caller.agentId) {
          return toolError('not_leased', 'You hold no leased worktree at that path.')
        }
        const outcome = await deps.pool.release(lease.leaseId)
        switch (outcome) {
          case 'returned':
            return toolSuccess({ released: true, branch: lease.branch })
          case 'held':
            return toolSuccess({
              released: true,
              branch: lease.branch,
              note: 'It still held changes, so it is kept aside for the person to commit, stash or discard.',
            })
          case 'postponed':
            return toolSuccess({
              released: false,
              branch: lease.branch,
              note: 'Something still runs in the worktree (a terminal in it?); it is still yours.',
            })
          default:
            return toolError('unavailable', 'The worktree is busy; try again in a moment.')
        }
      },
    },
  ]
}
