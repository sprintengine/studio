import assert from 'node:assert/strict'

import {
  agentWorktreePaths,
  connectorMcpSettings,
  connectorStartupPrompt,
  connectorWorktreeBranch,
  connectorWorktreePaths,
  connectorWorktreeSlug,
  findHealthyWorktreeScope,
  resolveWorkspaceTerminalCwd,
  resolveWorkspaceWorktree,
  resolveWorkspaceWorktrees,
  resolveWorktreeFallbackRoot,
  resolveWorktreeSpawnFallback,
  slugifyWorktreeName,
  worktreeContainerPath,
  worktreeIdFromPath,
  type WorktreeScopeCandidate,
} from './workspaceWorktree'
import { resolveSkillInvocation } from '../../../shared/skill-invocation'
import type { McpServerConfig, Workspace } from '../types/workspace'
import type { PluginSkillCatalog } from '../../../shared/plugin-manifest'

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
    // A store with no `repos` list describes its one repo with the flat fields:
    // that repo is the primary, and its root is the workspace itself.
    repoId: 'primary',
    repoRoot: '/Users/example/project',
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
  assert.equal(resolved?.repoId, undefined, 'a non-sprint worktree workspace declares no repo set')
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

// --- resolveWorkspaceWorktrees: one scope per declared repo (MC-1610) ---

/** A run declaring two projects: the primary, plus a `mobile` sibling. */
function twoRepoWorkspace(): WorktreeInput {
  return make({
    sprintEngineState: {
      vcs: {
        mode: 'run_worktree',
        worktreePath: '.multi-code/sprintengine/x/worktree',
        branchName: 'sprintengine/x',
        repos: [
          { id: 'primary', root: '.', worktreePath: '.multi-code/sprintengine/x/worktree', branchName: 'sprintengine/x' },
          { id: 'mobile', root: '../multicode-mobile', worktreePath: '.multi-code/sprintengine/x/worktree-mobile', branchName: 'sprintengine/x' },
        ],
      },
    } as unknown as Workspace['sprintEngineState'],
  })
}

// 8. Every declared repo gets a scope, primary first; each carries its own
//    worktree, branch, and the root of the checkout it was created from.
{
  const resolved = resolveWorkspaceWorktrees(twoRepoWorkspace())
  assert.deepEqual(resolved, [
    {
      gitRoot: '/Users/example/project/.multi-code/sprintengine/x/worktree',
      branch: 'sprintengine/x',
      repoId: 'primary',
      repoRoot: '/Users/example/project',
    },
    {
      gitRoot: '/Users/example/project/.multi-code/sprintengine/x/worktree-mobile',
      branch: 'sprintengine/x',
      repoId: 'mobile',
      repoRoot: '/Users/example/multicode-mobile',
    },
  ])
  // "The" worktree stays the PRIMARY one for every single-scope surface.
  assert.equal(resolveWorkspaceWorktree(twoRepoWorkspace())?.repoId, 'primary')
}

// 9. Single-repo control: a one-entry list resolves to exactly the one scope a
//    single-repo run always had.
{
  const ws = make({
    sprintEngineState: {
      vcs: {
        mode: 'run_worktree',
        worktreePath: '.multi-code/sprintengine/x/worktree',
        branchName: 'sprintengine/x',
        repos: [{ id: 'primary', root: '.', worktreePath: '.multi-code/sprintengine/x/worktree', branchName: 'sprintengine/x' }],
      },
    } as unknown as Workspace['sprintEngineState'],
  })
  assert.deepEqual(resolveWorkspaceWorktrees(ws), [{
    gitRoot: '/Users/example/project/.multi-code/sprintengine/x/worktree',
    branch: 'sprintengine/x',
    repoId: 'primary',
    repoRoot: '/Users/example/project',
  }])
  assert.deepEqual(resolveWorkspaceWorktrees(make({})), [], 'a regular workspace is backed by no worktree')
}

// --- resolveWorktreeFallbackRoot: fall back per repo, not to the workspace ---

// 10. A pruned SIBLING worktree falls back to that sibling's own repo root; the
//     primary's falls back to the workspace, which is its root.
{
  const ws = twoRepoWorkspace()
  assert.equal(
    resolveWorktreeFallbackRoot(ws, '/Users/example/project/.multi-code/sprintengine/x/worktree-mobile'),
    '/Users/example/multicode-mobile',
    'a pruned mobile worktree redirects into the mobile checkout, not the multicode root',
  )
  assert.equal(
    resolveWorktreeFallbackRoot(ws, '/Users/example/project/.multi-code/sprintengine/x/worktree'),
    '/Users/example/project',
  )
  // A cwd belonging to no declared worktree, and a workspace with none at all,
  // both fall back to the workspace folder — today's behavior.
  assert.equal(resolveWorktreeFallbackRoot(ws, '/somewhere/else'), '/Users/example/project')
  assert.equal(resolveWorktreeFallbackRoot(ws, undefined), '/Users/example/project')
  assert.equal(resolveWorktreeFallbackRoot(make({}), '/x'), '/Users/example/project')
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

// --- connector chats ---

// 18. Branch + slug are derived from the connector id and a unique suffix.
{
  assert.equal(connectorWorktreeBranch('railway', 'a1b2c3d4'), 'connector/railway-a1b2c3d4')
  assert.equal(connectorWorktreeSlug('railway', 'a1b2c3d4'), 'railway-a1b2c3d4')
}

// 19. Worktree paths land under the repo's shared `.multicode-worktrees/<repo>`
//     container (worktreeContainerPath — the single source the Worktree manager
//     also uses).
{
  assert.equal(worktreeContainerPath('/Users/example/project'), '/Users/example/.multicode-worktrees/project')
  const paths = connectorWorktreePaths('/Users/example/project', 'railway', 'a1b2c3d4')
  assert.deepEqual(paths, {
    containerPath: '/Users/example/.multicode-worktrees/project',
    destinationPath: '/Users/example/.multicode-worktrees/project/railway-a1b2c3d4',
    slug: 'railway-a1b2c3d4',
    branchName: 'connector/railway-a1b2c3d4',
  })
}

// 20. connectorMcpSettings wraps exactly one server with sync ON — never a second
//     server, so the spawn syncs only the connector into the worktree.
{
  const railway: McpServerConfig = {
    id: 'railway',
    name: 'Railway',
    transport: 'http',
    url: 'https://mcp.railway.com',
    enabled: true,
    clients: ['codex', 'claude'],
    scope: 'workspace',
    source: 'bundled',
    riskLevel: 'secrets',
  }
  const settings = connectorMcpSettings(railway)
  assert.equal(settings.syncEnabled, true)
  assert.deepEqual(Object.keys(settings.servers), ['railway'])
  assert.equal(settings.servers.railway, railway)
}

// 21. resolveSkillInvocation (shared with the debug launch path) is the plugin's
//     CLI-native explicit template with {{skillId}} substituted — `/use-railway`
//     (Claude) and `Use $use-railway.` (Codex).
{
  const claude: PluginSkillCatalog = {
    support: 'native',
    harnessId: 'claude',
    installTargets: [{ scope: 'workspace', path: '{{workspaceRoot}}/.claude/skills/{{skillId}}', format: 'claude-code', restartRequired: true }],
    invocation: { explicitTemplate: '/{{skillId}}', nativeSlashCommand: true },
  }
  const codex: PluginSkillCatalog = {
    support: 'native',
    harnessId: 'codex',
    installTargets: [{ scope: 'workspace', path: '{{workspaceRoot}}/.codex/skills/{{skillId}}', format: 'codex', restartRequired: true }],
    invocation: { explicitTemplate: 'Use ${{skillId}}.', explicitMention: true },
  }
  assert.equal(resolveSkillInvocation(claude, 'use-railway'), '/use-railway')
  assert.equal(resolveSkillInvocation(codex, 'use-railway'), 'Use $use-railway.')
}

// 22. No native skill support (or no plugin, or no explicit template) → undefined,
//     so the caller falls back to the plain instruction.
{
  assert.equal(resolveSkillInvocation(undefined, 'use-railway'), undefined)
  const unsupported: PluginSkillCatalog = { support: 'unsupported', harnessId: 'x', installTargets: [] }
  assert.equal(resolveSkillInvocation(unsupported, 'use-railway'), undefined)
  const noTemplate: PluginSkillCatalog = { support: 'native', harnessId: 'claude', installTargets: [{ scope: 'workspace', path: '{{workspaceRoot}}/.claude/skills/{{skillId}}', format: 'claude-code', restartRequired: true }], invocation: {} }
  assert.equal(resolveSkillInvocation(noTemplate, 'use-railway'), undefined)
}

// 23. Startup prompt leads with the invocation (when present) then the instruction;
//     without an invocation it is the bare instruction.
{
  assert.equal(
    connectorStartupPrompt('/use-railway', 'Show me my Railway environment and flag anything failing.'),
    '/use-railway\n\nShow me my Railway environment and flag anything failing.',
  )
  assert.equal(connectorStartupPrompt(undefined, 'Show me my Railway environment.'), 'Show me my Railway environment.')
}

// --- agent spawn worktrees ---

// 28. Slug + id derivation (shared with the Worktree manager): messy names
//     reduce to a safe slug; ids are path-derived and separator-free.
{
  assert.equal(slugifyWorktreeName('  Fix Payments!! '), 'fix-payments')
  assert.equal(slugifyWorktreeName('///'), '')
  assert.equal(
    worktreeIdFromPath('/Users/example/.multicode-worktrees/project/nova-x1'),
    'worktree-users-example-multicode-worktrees-project-nova-x1',
  )
}

// 29. Agent worktree paths land under the same shared container as the Worktree
//     manager and connector chats, on an `agent/<slug>` branch.
{
  const paths = agentWorktreePaths('/Users/example/project', 'Fix Payments')
  assert.deepEqual(paths, {
    containerPath: '/Users/example/.multicode-worktrees/project',
    destinationPath: '/Users/example/.multicode-worktrees/project/fix-payments',
    slug: 'fix-payments',
    branchName: 'agent/fix-payments',
  })
}

// 30. A name that reduces to an empty slug → null (caller surfaces the error
//     instead of creating a worktree at the container root).
{
  assert.equal(agentWorktreePaths('/Users/example/project', ' // '), null)
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

  // --- resolveWorkspaceTerminalCwd ---

  // 24. Null gitRoot → not worktree-backed, no override, never probes the fs.
  {
    let probed = false
    const result = await resolveWorkspaceTerminalCwd(null, '/proj', async () => {
      probed = true
      return true
    })
    assert.deepEqual(result, { cwd: null, missing: false })
    assert.equal(probed, false, 'null gitRoot must not stat')
  }

  // 25. gitRoot === folderPath → the workspace folder already IS the worktree
  //     (worktree-opened / connector-chat), so no override and no fs probe.
  {
    let probed = false
    const result = await resolveWorkspaceTerminalCwd('/wt/spike', '/wt/spike', async () => {
      probed = true
      return true
    })
    assert.deepEqual(result, { cwd: null, missing: false })
    assert.equal(probed, false, 'samePath short-circuits before probing')
  }

  // 26. Distinct gitRoot present on disk → spawn into the worktree.
  {
    const result = await resolveWorkspaceTerminalCwd(
      '/proj/.multi-code/sprintengine/a/worktree',
      '/proj',
      existsAlways,
    )
    assert.deepEqual(result, { cwd: '/proj/.multi-code/sprintengine/a/worktree', missing: false })
  }

  // 27. Distinct gitRoot gone from disk → missing, no cwd override.
  {
    const result = await resolveWorkspaceTerminalCwd(
      '/proj/.multi-code/sprintengine/a/worktree',
      '/proj',
      existsNever,
    )
    assert.deepEqual(result, { cwd: null, missing: true })
  }

  console.log('workspaceWorktree.test.ts: ok')
})()
