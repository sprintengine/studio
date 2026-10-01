// The editor.* tools' backends, from the app's own readers: git's status, the
// branch steps the diff pane walks, the agent changelists, and the terminal
// runtime's view of the calling session. Kept out of app-services so that file
// only says which services are handed in.

import { realpath as realpathCallback, promises as fsPromises } from 'node:fs'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

import type { TerminalSessionSnapshot } from '../../shared/ipc/terminal'
import { changelistOwnerId, pathsOfChangelist } from '../../shared/git/changelists'
import type { EditorAgentSession, EditorDiffSource, EditorToolsDeps } from '../automation/editor-tools'
import { diffBranchSelection, listBranchSteps } from '../branch-steps'
import { getGitRepoRoot } from '../git'
import { getGitChangelists } from '../git-changelists'
import { getGitStatus } from '../git-status'
import { runGitCommand } from '../git-utils'
import { listGitWorktrees } from '../git-worktree-list'
import type { AgentWrittenFiles } from './agent-written-files'
import type { EditorRevealBroker } from './editor-reveal-broker'
import type { PathPolicyFs } from './path-policy'

// `realpath.native` resolves the case a case-insensitive volume stores, so two
// spellings of one file compare equal; the JS implementation does not.
const nativeRealpath = promisify(realpathCallback.native)

export const nodePathPolicyFs: PathPolicyFs = {
  realpath: (path) => nativeRealpath(path),
  stat: (path) => fsPromises.stat(path),
  readFile: (path) => fsPromises.readFile(path),
}

export function editorSessionFrom(snapshot: TerminalSessionSnapshot): EditorAgentSession {
  return {
    cwd: snapshot.cwd ?? null,
    worktreePath: snapshot.worktreePath ?? null,
    gitRoot: snapshot.observedCheckout?.gitRoot ?? null,
    hostId: snapshot.hostId ?? null,
    pathStyle: snapshot.pathStyle ?? null,
    fileChanges: (snapshot.fileChanges ?? []).map((change) => change.path),
  }
}

/**
 * The session an agent connection speaks for: its agent terminal in that
 * workspace, the live one first when a relaunch left an exited one behind.
 */
export function findEditorAgentSession(
  sessions: readonly TerminalSessionSnapshot[],
  workspaceId: string,
  agentId: string,
): EditorAgentSession | null {
  const candidates = sessions.filter(
    (session) => session.agentId === agentId && (!session.workspaceId || session.workspaceId === workspaceId),
  )
  const chosen = candidates.find((session) => session.processAlive) ?? candidates[0]
  return chosen ? editorSessionFrom(chosen) : null
}

export function createGitEditorDiffSource(userDataDir: () => string): EditorDiffSource {
  return {
    async workingTree(repoRoot) {
      const status = await getGitStatus(repoRoot)
      return Object.values(status.files).map((entry) => ({
        relativePath: entry.relativePath,
        staged: entry.staged,
        unstaged: entry.unstaged,
      }))
    },
    async branch(repoRoot) {
      return (await diffBranchSelection(repoRoot, { kind: 'span' })).files.map((file) => file.path)
    },
    async commit(repoRoot, hash) {
      return (await diffBranchSelection(repoRoot, { kind: 'commit', hash })).files.map((file) => file.path)
    },
    async resolveCommit(repoRoot, revision) {
      // `--end-of-options` keeps a revision that looks like a flag from being
      // read as one; the tool refuses a leading dash before it gets here too.
      const result = await runGitCommand(repoRoot, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${revision}^{commit}`,
      ])
      const hash = result.ok ? result.stdout.trim() : ''
      return /^[0-9a-f]{40,64}$/.test(hash) ? hash : null
    },
    async branchCommits(repoRoot) {
      return (await listBranchSteps(repoRoot)).steps.map((step) => step.hash)
    },
    async agentChangelistPaths(repoRoot, agentId) {
      const lists = await getGitChangelists(userDataDir(), repoRoot)
      const mine = lists.find((list) => list.id === changelistOwnerId(agentId))
      return mine ? pathsOfChangelist(mine) : null
    },
  }
}

export function createEditorToolBackends(options: {
  findWorkspace: EditorToolsDeps['findWorkspace']
  listTerminalSessions: () => readonly TerminalSessionSnapshot[]
  agentWrittenFiles: AgentWrittenFiles
  broker: EditorRevealBroker
  userDataDir: () => string
  isAppFocused: () => boolean
}): EditorToolsDeps {
  return {
    findWorkspace: options.findWorkspace,
    findAgentSession: (workspaceId, agentId) =>
      findEditorAgentSession(options.listTerminalSessions(), workspaceId, agentId),
    agentWrittenPaths: (agentId) => options.agentWrittenFiles.pathsOf(agentId),
    resolveRepoRoot: (directory) => getGitRepoRoot(directory),
    listWorktreePaths: async (repoRoot) => {
      const listed = await listGitWorktrees(repoRoot, { resolvedRoot: true })
      return listed.ok ? listed.data.worktrees.filter((entry) => !entry.bare).map((entry) => entry.path) : []
    },
    fs: nodePathPolicyFs,
    homeDir: () => homedir(),
    userDataDir: options.userDataDir,
    reveal: (request) => options.broker.reveal(request),
    queryState: (workspaceId) => options.broker.queryState(workspaceId),
    hasPendingReveal: (workspaceId) => options.broker.hasPending(workspaceId),
    isAppFocused: options.isAppFocused,
    diff: createGitEditorDiffSource(options.userDataDir),
  }
}
