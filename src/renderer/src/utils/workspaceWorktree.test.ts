import assert from 'node:assert/strict'

import { findHealthyWorktreeScope, resolveWorkspaceWorktree, resolveWorktreeSpawnFallback, type WorktreeScopeCandidate } from './workspaceWorktree'
import type { Workspace } from '../types/workspace'

type WorktreeInput = Pick<Workspace, 'folderPath' | 'worktree' | 'sprintEngineState'>

function make(overrides: Partial<WorktreeInput>): WorktreeInput {
  return {
    folderPath: '/Users/example/project',
    worktree: null,
    sprintEngineState: null,
    ...overrides,
  }
}

// 1. Sprint run in worktree mode: git root redirects to the worktree (folderPath
//    + project-relative worktreePath), branch comes from vcs.branchName.
{
  const ws = make({
    sprintEngineState: {
      vcs: {
        mode: 'run_worktree',
        worktreePath: '.multi-code/sprintengine/auth/worktree',
        branchName: 'sprintengine/auth',
      },
    } as unknown as Workspace['sprintEngineState'],
  })
  const resolved = resolveWorkspaceWorktree(ws)
  assert.deepEqual(resolved, {
    gitRoot: '/Users/example/project/.multi-code/sprintengine/auth/worktree',
    branch: 'sprintengine/auth',
  })
}

// 2. Normal worktree workspace (Open as workspace): folderPath already IS the
//    worktree, so git root stays folderPath; branch from the explicit marker.
{
  const ws = make({
    folderPath: '/Users/example/wt/parser-spike',
    worktree: { branch: 'spike/parser' },
  })
  const resolved = resolveWorkspaceWorktree(ws)
  assert.deepEqual(resolved, {
    gitRoot: '/Users/example/wt/parser-spike',
    branch: 'spike/parser',
  })
}

// 3. Sprint vcs takes precedence over an explicit marker (a worktree-mode sprint
//    is always rooted at its run worktree).
{
  const ws = make({
    worktree: { branch: 'ignored' },
    sprintEngineState: {
      vcs: { mode: 'run_worktree', worktreePath: '.multi-code/sprintengine/x/worktree', branchName: 'sprintengine/x' },
    } as unknown as Workspace['sprintEngineState'],
  })
  assert.equal(resolveWorkspaceWorktree(ws)?.branch, 'sprintengine/x')
}

// 4. Regular workspace (no worktree, no run vcs) → null (unchanged behavior).
{
  assert.equal(resolveWorkspaceWorktree(make({})), null)
}

// 5. No folderPath → null even with a marker (can't resolve a git root).
{
  assert.equal(resolveWorkspaceWorktree(make({ folderPath: null, worktree: { branch: 'b' } })), null)
}

// 6. A sprint NOT in worktree mode (no vcs) → null.
{
  const ws = make({ sprintEngineState: { vcs: null } as unknown as Workspace['sprintEngineState'] })
  assert.equal(resolveWorkspaceWorktree(ws), null)
}

// 7. Defensive: an (out-of-contract) absolute worktreePath is used as-is, not
//    nested under folderPath.
{
  const ws = make({
    sprintEngineState: {
      vcs: { mode: 'run_worktree', worktreePath: '/abs/worktree', branchName: 'sprintengine/x' },
    } as unknown as Workspace['sprintEngineState'],
  })
  assert.equal(resolveWorkspaceWorktree(ws)?.gitRoot, '/abs/worktree')
}

// --- findHealthyWorktreeScope ---

const scope = (overrides: Partial<WorktreeScopeCandidate>): WorktreeScopeCandidate => ({
  id: 'worktree:/x',
  path: '/x',
  branch: null,
  missing: false,
  locked: false,
  prunable: false,
  ...overrides,
})

const mainScope = scope({ id: 'main', path: '/Users/example/project', branch: 'main' })

// 8. Matches the worktree by path.
{
  const wt = scope({ id: 'worktree:/wt', path: '/Users/example/project/.multi-code/sprintengine/a/worktree', branch: 'sprintengine/a' })
  const found = findHealthyWorktreeScope([mainScope, wt], wt.path, 'sprintengine/a')
  assert.equal(found?.id, wt.id)
}

// 9. Branch recovers the match when the path diverges (symlinked root): the
//    joined gitRoot points at /tmp/... but git lists /private/tmp/...
{
  const wt = scope({ id: 'worktree:/private', path: '/private/tmp/proj/.multi-code/sprintengine/a/worktree', branch: 'sprintengine/a' })
  const joinedButSymlinked = '/tmp/proj/.multi-code/sprintengine/a/worktree'
  const found = findHealthyWorktreeScope([mainScope, wt], joinedButSymlinked, 'sprintengine/a')
  assert.equal(found?.id, wt.id, 'branch match recovers a symlinked path divergence')
}

// 10. Unhealthy worktree scopes are excluded → null (so the panel stays on main
//     and does not loop with the validity-reset effect).
{
  for (const bad of [{ prunable: true }, { missing: true }, { locked: true }]) {
    const wt = scope({ id: 'worktree:/wt', path: '/wt', branch: 'sprintengine/a', ...bad })
    assert.equal(
      findHealthyWorktreeScope([mainScope, wt], '/wt', 'sprintengine/a'),
      null,
      `excludes ${JSON.stringify(bad)} worktree`,
    )
  }
}

// 11. No gitRoot and no branch → null (a non-worktree workspace).
{
  assert.equal(findHealthyWorktreeScope([mainScope], null, null), null)
}

// 12. No matching scope present → null (worktree not yet listed).
{
  assert.equal(findHealthyWorktreeScope([mainScope], '/wt', 'sprintengine/a'), null)
}

// --- resolveWorktreeSpawnFallback ---

const existsAlways = async () => true
const existsNever = async () => false

void (async () => {
  // 13. Worktree cwd still present → pass through unchanged, no fallback.
  {
    const result = await resolveWorktreeSpawnFallback(
      'worktree',
      '/proj/.multi-code/sprintengine/a/worktree',
      '/proj',
      existsAlways,
    )
    assert.deepEqual(result, { fellBack: false, cwd: '/proj/.multi-code/sprintengine/a/worktree' })
  }

  // 14. Worktree cwd removed → fall back to the workspace folder and flag it.
  {
    const result = await resolveWorktreeSpawnFallback(
      'worktree',
      '/proj/.multi-code/sprintengine/a/worktree',
      '/proj',
      existsNever,
    )
    assert.deepEqual(result, { fellBack: true, cwd: '/proj' })
  }

  // 15. Non-worktree agent → never probes the filesystem, passes through.
  {
    let probed = false
    const result = await resolveWorktreeSpawnFallback(
      'current_workspace',
      undefined,
      '/proj',
      async () => {
        probed = true
        return false
      },
    )
    assert.deepEqual(result, { fellBack: false, cwd: undefined })
    assert.equal(probed, false, 'non-worktree agents must not stat a cwd')
  }

  // 16. Worktree mode but no cwd recorded → pass through (nothing to probe).
  {
    const result = await resolveWorktreeSpawnFallback('worktree', undefined, '/proj', existsNever)
    assert.deepEqual(result, { fellBack: false, cwd: undefined })
  }

  // 17. Removed worktree with no workspace folder → fell back with undefined cwd
  //     (caller lets the launch surface the missing-root error).
  {
    const result = await resolveWorktreeSpawnFallback('worktree', '/gone/worktree', null, existsNever)
    assert.deepEqual(result, { fellBack: true, cwd: undefined })
  }

  console.log('workspaceWorktree.test.ts: ok')
})()
