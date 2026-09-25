import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import type { EditorRevealRequest, EditorRevealShown } from '../../shared/editor-reveal'
import type { McpConnectionContext, McpToolRegistration } from '../../shared/modules/mcp-tools'
import { nodePathPolicyFs } from '../editor-reveal/editor-tool-backends'
import { createEditorTools, EDITOR_MUTATION_TOOL_NAMES, type EditorToolsDeps } from './editor-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { requiredScopeForTool } from './tailnet/tailnet-scopes'

let root = ''
let repo = ''
let outside = ''

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'editor-tools-')))
  repo = join(root, 'repo')
  outside = join(root, 'tmp')
  await mkdir(join(repo, 'src'), { recursive: true })
  await mkdir(outside, { recursive: true })
  for (const name of ['a.ts', 'b.ts', 'c.ts']) await writeFile(join(repo, 'src', name), 'x\n'.repeat(20))
  await writeFile(join(outside, 'fix.patch'), '+y\n')
  await writeFile(join(outside, 'other.txt'), 'z\n')
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

const agent: McpConnectionContext = {
  metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-7', agentName: 'Claude' },
}

function build(overrides: Partial<EditorToolsDeps> = {}, shown: EditorRevealShown = 'foreground') {
  const reveals: Array<Omit<EditorRevealRequest, 'requestId'>> = []
  const deps: EditorToolsDeps = {
    findWorkspace: (id) => (id === 'ws-1' ? { folderPath: repo } : null),
    findAgentSession: () => ({
      cwd: repo,
      worktreePath: null,
      gitRoot: repo,
      hostId: null,
      pathStyle: null,
      fileChanges: [],
    }),
    agentWrittenPaths: () => [join(outside, 'fix.patch')],
    resolveRepoRoot: async (dir) => (dir.startsWith(repo) ? repo : null),
    listWorktreePaths: async () => [repo],
    fs: nodePathPolicyFs,
    homeDir: () => join(root, 'home'),
    userDataDir: () => join(root, 'user-data'),
    reveal: async (request) => {
      reveals.push(request)
      return { shown }
    },
    queryState: async () => ({
      windowVisible: true,
      active: {
        path: join(repo, 'src', 'a.ts'),
        view: 'file',
        visibleRange: { startLine: 1, endLine: 20 },
        selection: null,
      },
      openFiles: [join(repo, 'src', 'a.ts')],
      awaitingOwner: 0,
    }),
    hasPendingReveal: () => false,
    isAppFocused: () => false,
    diff: {
      workingTree: async () =>
        Array.from({ length: 40 }, (_, index) => ({
          relativePath: index < 3 ? `src/${'abc'[index]}.ts` : `other/file-${index}.ts`,
          staged: false,
          unstaged: true,
        })),
      branch: async () => ['src/a.ts', 'src/b.ts'],
      commit: async () => ['src/a.ts'],
      resolveCommit: async (_repo, revision) =>
        revision === 'abc1234' ? 'a'.repeat(40) : revision === 'offbranch' ? 'b'.repeat(40) : null,
      branchCommits: async () => ['a'.repeat(40)],
      agentChangelistPaths: async () => ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    },
    ...overrides,
  }
  const tools = createEditorTools(deps)
  const tool = (name: string): McpToolRegistration => {
    const found = tools.find((candidate) => candidate.name === name)
    assert.ok(found, name)
    return found
  }
  return { tool, reveals }
}

function structured(result: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  return result.structuredContent ?? {}
}

test('open and open_diff are audited mutations needing workspace:operate; state is a read', () => {
  assert.deepEqual([...EDITOR_MUTATION_TOOL_NAMES].sort(), ['editor.open', 'editor.open_diff'])
  for (const name of EDITOR_MUTATION_TOOL_NAMES) {
    assert.equal(isStudioGatewayMutation(name), true, name)
    assert.equal(requiredScopeForTool(name, isStudioGatewayMutation(name)), 'workspace:operate')
  }
  assert.equal(isStudioGatewayMutation('editor.state'), false)
  assert.equal(requiredScopeForTool('editor.state', false), 'workspace:read')
})

test('editor.open sorts files into opened, awaiting_owner and refused, and sends only what it may', async () => {
  const { tool, reveals } = build()
  const result = await tool('editor.open').handler(
    {
      files: [
        { path: 'src/a.ts', range: { startLine: 4, endLine: 90 } },
        { path: join(outside, 'fix.patch') },
        { path: join(outside, 'other.txt') },
        { path: 'src/missing.ts' },
      ],
      note: 'The retry loop',
    },
    agent,
  )
  assert.equal(result.isError, undefined)
  const body = structured(result)
  assert.equal(body.shown, 'foreground')
  const files = body.files as Array<Record<string, unknown>>
  assert.deepEqual(
    files.map((file) => [file.displayPath, file.status, file.reason]),
    [
      ['src/a.ts', 'opened', null],
      [join(outside, 'fix.patch'), 'opened', null],
      [join(outside, 'other.txt'), 'awaiting_owner', 'outside_workspace'],
      ['src/missing.ts', 'refused', 'not_found'],
    ],
  )
  assert.equal(files[0].lineCount, 20)
  assert.equal(reveals.length, 1)
  const sent = reveals[0]
  assert.equal(sent.note, 'The retry loop')
  assert.deepEqual(
    sent.files.map((file) => file.path),
    [join(repo, 'src', 'a.ts'), join(outside, 'fix.patch')],
  )
  // Clamped to the file: the editor cannot show line 90 of 20.
  assert.deepEqual(sent.files[0].range, { startLine: 4, endLine: 20 })
  assert.deepEqual(
    sent.awaiting.map((file) => file.path),
    [join(outside, 'other.txt')],
  )
})

test('not_visible is passed on with the instruction not to retry', async () => {
  const { tool } = build({}, 'not_visible')
  const body = structured(await tool('editor.open').handler({ files: [{ path: 'src/a.ts' }] }, agent))
  assert.equal(body.shown, 'not_visible')
  assert.match(String(body.note), /do not retry/)
})

test('a paired device cannot open what an agent wrote outside the workspace', async () => {
  const { tool, reveals } = build()
  const remote: McpConnectionContext = {
    metadata: { kind: 'remote-tailnet', workspaceId: 'ws-1', agentId: 'agent-7', deviceId: 'android-phone' },
  }
  const body = structured(await tool('editor.open').handler({ files: [{ path: join(outside, 'fix.patch') }] }, remote))
  const [file] = body.files as Array<Record<string, unknown>>
  assert.equal(file.status, 'refused')
  assert.equal(file.reason, 'outside_workspace')
  assert.equal(reveals.length, 0, 'nothing to show, so no window is asked')
})

test('the arguments are checked before anything is resolved', async () => {
  const { tool } = build()
  const open = tool('editor.open')
  assert.equal((await open.handler({ files: [] }, agent)).isError, true)
  assert.equal((await open.handler({ files: Array(9).fill({ path: 'src/a.ts' }) }, agent)).isError, true)
  assert.equal((await open.handler({ files: [{ path: 'src/a.ts', range: { startLine: 0 } }] }, agent)).isError, true)
  assert.equal((await open.handler({ files: [{ path: 'src/a.ts' }], note: 'x'.repeat(141) }, agent)).isError, true)
  // Bound connections cannot reach into another workspace.
  const other = await open.handler({ files: [{ path: 'src/a.ts' }], workspaceId: 'ws-2' }, agent)
  assert.equal(structured(other).error && (structured(other).error as { code: string }).code, 'forbidden')
})

test('open_diff shows the agent its own changes by default, narrowed by paths, with the totals', async () => {
  const { tool, reveals } = build()
  const result = await tool('editor.open_diff').handler(
    { paths: ['src/b.ts', 'src/a.ts', 'README.md'], focus: { path: 'src/b.ts', range: { startLine: 7 } } },
    agent,
  )
  const body = structured(result)
  assert.equal(body.fileCount, 2)
  assert.equal(body.totalChangedFiles, 40)
  assert.equal(body.repoRoot, repo)
  const files = body.files as Array<Record<string, unknown>>
  assert.deepEqual(
    files.map((file) => [file.displayPath, file.status]),
    [
      ['src/b.ts', 'opened'],
      ['src/a.ts', 'opened'],
      ['README.md', 'refused'],
    ],
  )
  const diff = reveals[0].diff
  assert.ok(diff)
  assert.equal(diff.changelistId, 'agent:agent-7')
  assert.deepEqual(diff.paths, ['src/b.ts', 'src/a.ts'])
  // "Showing 2 of 3": the view without `paths` is the agent's own three files.
  assert.equal(diff.totalChangedFiles, 3)
  assert.equal(diff.focusPath, `${repo}/src/b.ts`)
  assert.deepEqual(diff.focusRange, { startLine: 7 })
  assert.deepEqual(diff.step, { kind: 'uncommitted' })
})

test('open_diff: all changes, a branch view, and a commit that must be one of the branch steps', async () => {
  const { tool, reveals } = build()
  const all = structured(await tool('editor.open_diff').handler({ only: 'all' }, agent))
  assert.equal(all.fileCount, 40)
  assert.equal(reveals[0].diff?.changelistId, null)

  const branch = structured(await tool('editor.open_diff').handler({ changes: 'branch' }, agent))
  assert.equal(branch.fileCount, 2)
  assert.deepEqual(reveals[1].diff?.step, { kind: 'span' })

  const commit = structured(await tool('editor.open_diff').handler({ changes: 'commit', commit: 'abc1234' }, agent))
  assert.equal(commit.fileCount, 1)
  assert.deepEqual(reveals[2].diff?.step, { kind: 'commit', hash: 'a'.repeat(40) })

  const offBranch = await tool('editor.open_diff').handler({ changes: 'commit', commit: 'offbranch' }, agent)
  assert.equal(offBranch.isError, true)
  const flag = await tool('editor.open_diff').handler({ changes: 'commit', commit: '--output=/tmp/x' }, agent)
  assert.equal(flag.isError, true)
})

test('open_diff with nothing of the agent’s own says so instead of opening an empty viewer', async () => {
  const { tool, reveals } = build({
    diff: {
      workingTree: async () => [{ relativePath: 'other/x.ts', staged: false, unstaged: true }],
      branch: async () => [],
      commit: async () => [],
      resolveCommit: async () => null,
      branchCommits: async () => [],
      agentChangelistPaths: async () => null,
    },
  })
  const result = await tool('editor.open_diff').handler({}, agent)
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result.structuredContent), /only: \\"all\\"/)
  assert.equal(reveals.length, 0)
})

test('editor.state reports what the window showing the workspace shows', async () => {
  const { tool } = build({ hasPendingReveal: () => true })
  const body = structured(await tool('editor.state').handler({}, agent))
  assert.equal(body.visible, true)
  assert.equal(body.appFocused, false)
  assert.equal((body.active as { path: string }).path, join(repo, 'src', 'a.ts'))
  assert.deepEqual(body.openFiles, [join(repo, 'src', 'a.ts')])
  assert.equal(body.pendingForOwner, 1)

  const { tool: headless } = build({ queryState: async () => null })
  const none = structured(await headless('editor.state').handler({}, agent))
  assert.equal(none.visible, false)
  assert.equal(none.active, null)
})

test("the checkout an agent's hooks last saw does not widen what it may show", async () => {
  // The agent cd'd into another repository (its hooks report `gitRoot` there).
  const { tool, reveals } = build({
    findAgentSession: () => ({
      cwd: repo,
      worktreePath: null,
      gitRoot: outside,
      hostId: null,
      pathStyle: null,
      fileChanges: [],
    }),
    agentWrittenPaths: () => [],
    resolveRepoRoot: async (dir) => (dir.startsWith(repo) ? repo : dir.startsWith(outside) ? outside : null),
  })
  const body = structured(await tool('editor.open').handler({ files: [{ path: join(outside, 'other.txt') }] }, agent))
  const [file] = body.files as Array<Record<string, unknown>>
  assert.equal(file.status, 'awaiting_owner')
  assert.equal(reveals[0].awaiting.length, 1)
})

test('the window is sent the real file, and a paired device is named as itself', async () => {
  const { tool, reveals } = build()
  const remote: McpConnectionContext = {
    metadata: { kind: 'remote-tailnet', workspaceId: 'ws-1', agentName: 'Claude', deviceName: 'android-phone' },
  }
  await tool('editor.open').handler({ files: [{ path: 'src/a.ts' }] }, remote)
  assert.equal(reveals[0].agentName, 'android-phone')
  assert.equal(reveals[0].files[0].path, join(repo, 'src', 'a.ts'))
})
