import assert from 'node:assert/strict'
import { formatDroppedPathsForTerminal, type FileDropPayload } from './terminalDrop'

function payload(path: string, rootPath = 'C:\\repo'): FileDropPayload {
  return {
    version: 1,
    workspaceId: 'workspace-1',
    rootPath,
    files: [{ path, name: path.split(/[/\\]/).at(-1) ?? path }],
  }
}

function directoryPayload(path: string, rootPath = 'C:\\repo'): FileDropPayload {
  return {
    version: 1,
    workspaceId: 'workspace-1',
    rootPath,
    files: [{ path, name: path.split(/[/\\]/).at(-1) ?? path, isDir: true }],
  }
}

function session(input: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot {
  return {
    sessionId: 'session-1',
    processAlive: true,
    kind: 'terminal',
    startedAt: 1,
    lastOutputAt: null,
    lastInputAt: null,
    lastVisibleAt: null,
    activity: { kind: 'idle', since: 1 },
    exitedAt: null,
    outputBufferLength: 0,
    retainedOutputBytes: 0,
    visible: true,
    ...input,
  }
}

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\repo\\src\\main.ts'),
    session({ cwd: 'C:\\repo', pathStyle: 'windows' })
  ),
  "'src\\main.ts'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\repo\\assets\\hero image.png'),
    session({ cwd: 'C:\\repo', pathStyle: 'wsl' })
  ),
  "'assets/hero image.png'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\Repo\\Assets\\HeroImage.PNG', 'C:\\Repo'),
    session({ cwd: 'C:\\Repo', pathStyle: 'wsl' })
  ),
  "'Assets/HeroImage.PNG'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\Repo\\Assets\\HeroImage.PNG', 'C:\\Repo'),
    session({ cwd: 'C:\\Repo', pathStyle: 'windows' })
  ),
  "'Assets\\HeroImage.PNG'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('/home/alex/repo/src/main.ts', '/home/alex/repo'),
    session({ cwd: '/home/alex/repo', pathStyle: 'posix' })
  ),
  "'src/main.ts'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    directoryPayload('C:\\repo\\src\\renderer', 'C:\\repo'),
    session({ cwd: 'C:\\repo\\.worktrees\\agent-1', pathStyle: 'windows' })
  ),
  "'src\\renderer'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    directoryPayload('/home/alex/repo/src/renderer', '/home/alex/repo'),
    session({ cwd: '/home/alex/repo/.worktrees/agent-1', pathStyle: 'posix' })
  ),
  "'src/renderer'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\other\\image.png'),
    session({ cwd: 'C:\\repo', pathStyle: 'wsl' })
  ),
  "'/mnt/c/other/image.png'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    {
      version: 1,
      workspaceId: 'workspace-1',
      rootPath: '/repo',
      files: [
        { path: "/repo/it's.png", name: "it's.png" },
        { path: '/repo/two words.txt', name: 'two words.txt' },
      ],
    },
    session({ cwd: '/repo', pathStyle: 'posix' })
  ),
  `'it'"'"'s.png' 'two words.txt'`
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('/repo/bad\nname.txt', '/repo'),
    session({ cwd: '/repo', pathStyle: 'posix' })
  ),
  ''
)
