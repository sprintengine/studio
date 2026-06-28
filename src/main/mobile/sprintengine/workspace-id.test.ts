import assert from 'node:assert/strict'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  deriveWorkspaceId,
  isWorkspaceIdToken,
  resolveWorkspaceIdToRoot,
  workspaceRootFromStatePath,
} from './workspace-id'
import { sanitizeMobileSnapshotForRelay, type MobileControlSnapshot } from './snapshot'
import { validateMobileWorkspacePath } from './workspace'

// Mirrors the relay's containsLocalPath guard (multiauth src/relay/result-summary.ts):
// the sanitized snapshot must contain none of these.
const localPathProbe =
  /(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/Volumes\/|\/Applications\/|\/Library\/|\/opt\/|\/srv\/|\/mnt\/|\/tmp\/|[A-Za-z]:\\|\\\\[^\\\s]+\\)/u

void main()

async function main(): Promise<void> {
  assertTokenRoundTrips()
  assertStateRootDerivation()
  assertSanitizerStripsLocalPaths()
  await assertValidateResolvesToken()
  console.log('workspace-id regression: all assertions passed')
}

function assertTokenRoundTrips(): void {
  const root = '/Users/example/workspace/projA'
  const token = deriveWorkspaceId(root)
  assert.equal(isWorkspaceIdToken(token), true)
  assert.equal(isWorkspaceIdToken(root), false)
  assert.equal(localPathProbe.test(token), false, 'token must be relay-safe')
  assert.equal(resolveWorkspaceIdToRoot(token, [root]), resolve(root))
  // Stable: same root always hashes to the same token.
  assert.equal(deriveWorkspaceId(root), token)
  // Fail closed when no candidate matches.
  assert.equal(resolveWorkspaceIdToRoot(token, ['/Users/example/workspace/projB']), null)
  assert.equal(resolveWorkspaceIdToRoot('ws_notarealtoken', [root]), null)
}

function assertStateRootDerivation(): void {
  const root = '/Users/example/workspace/projA'
  const statePath = join(root, '.multi-code', 'sprintengine', 'team-1', 'run.yaml')
  assert.equal(workspaceRootFromStatePath(statePath), resolve(root))
}

function assertSanitizerStripsLocalPaths(): void {
  const root = '/Users/example/workspace/projA'
  const snapshot = {
    protocolVersion: 1,
    generatedAt: '2026-06-27T00:00:00.000Z',
    desktopSessionId: 'sess',
    sprintEngines: [
      {
        sprintEngineId: 'team-1',
        name: 'Team One',
        workspacePath: root,
        statePath: join(root, '.multi-code', 'sprintengine', 'team-1', 'run.yaml'),
        planPath: join(root, '.multi-code', 'sprintengine', 'team-1', 'plan.md'),
        snapshotVersion: 'v1',
        updatedAt: '2026-06-27T00:00:00.000Z',
        board: {
          todo: 0, ready: 0, inProgress: 0, changesRequested: 0, review: 0,
          testing: 0, product: 0, needsInput: 0, blocked: 0, done: 0,
        },
        tasks: [],
        artifacts: [],
      },
    ],
    workspaces: [
      {
        workspaceId: `switchboard:${root}`,
        kind: 'switchboard',
        name: 'Switchboard',
        workspacePath: root,
        statePath: join(root, '.multi-code', 'switchboard'),
        updatedAt: '2026-06-27T00:00:00.000Z',
        capabilities: ['summary.read'],
        detailVersion: 2,
        summary: { status: 'idle' },
      },
    ],
    backlog: [
      {
        workspaceId: `backlog:${root}`,
        workspacePath: root,
        workspaceName: 'projA',
        updatedAt: '2026-06-27T00:00:00.000Z',
        items: [{ itemId: 'i1', relativePath: 'backlog/a.md', title: 'A', status: 'idea' }],
      },
    ],
  } as unknown as MobileControlSnapshot

  const safe = sanitizeMobileSnapshotForRelay(snapshot)

  // The whole payload must be free of local paths — this is exactly what the
  // relay rejects.
  assert.equal(localPathProbe.test(JSON.stringify(safe)), false, 'sanitized snapshot must contain no local path')

  // Sprint Engine paths are display-only / server-resolved.
  assert.equal(safe.sprintEngines[0].workspacePath, 'projA', 'board name comes from the folder basename')
  assert.equal(safe.sprintEngines[0].statePath, '')

  // Backlog workspacePath round-trips for create/start, so it must be a
  // resolvable token, and resolve back to the original root.
  const backlogToken = safe.backlog?.[0]?.workspacePath
  assert.equal(isWorkspaceIdToken(backlogToken ?? ''), true)
  assert.equal(resolveWorkspaceIdToRoot(backlogToken ?? '', [root]), resolve(root))
  assert.equal(safe.backlog?.[0]?.workspaceName, 'projA', 'display name preserved')
}

async function assertValidateResolvesToken(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ws-id-'))
  const token = deriveWorkspaceId(root)
  const resolved = await validateMobileWorkspacePath({
    workspacePath: token,
    allowedWorkspaceRoots: [root],
  })
  assert.equal(resolved, resolve(root), 'a workspace token validates to its real root')

  // An unresolvable token fails closed rather than guessing.
  await assert.rejects(
    validateMobileWorkspacePath({ workspacePath: 'ws_unknownunknownunknown', allowedWorkspaceRoots: [root] }),
    /not available/u
  )
}
