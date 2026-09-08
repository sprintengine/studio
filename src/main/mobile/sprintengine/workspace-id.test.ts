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
import { dispatchSnapshotRequest } from '../bridge/snapshot-request'
import { validateMobileControlSnapshot } from '../../../shared/mobile-control/protocol'

// Mirrors the relay's containsLocalPath guard (multiauth src/relay/result-summary.ts):
// the sanitized snapshot must contain none of these.
const localPathProbe =
  /(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/Volumes\/|\/Applications\/|\/Library\/|\/opt\/|\/srv\/|\/mnt\/|\/tmp\/|[A-Za-z]:\\|\\\\[^\\\s]+\\)/u

void main()

async function main(): Promise<void> {
  assertTokenRoundTrips()
  assertStateRootDerivation()
  assertSanitizerStripsLocalPaths()
  await assertOnDemandSnapshotIsSanitized()
  await assertValidateResolvesToken()
  console.log('workspace-id regression: all assertions passed')
}

function buildSnapshotFixture(root: string): MobileControlSnapshot {
  return {
    protocolVersion: 2,
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
        vcs: {
          worktree: true,
          branch: 'sprintengine/team-1',
          // MC-1613: a multi-repo run's projects. Their roots are workspace-RELATIVE,
          // so the sanitizer must leave them intact — redacting `../multicode-mobile`
          // would cost the phone the only field naming where a project lives.
          repos: [
            { id: 'primary', root: '.', branch: 'sprintengine/team-1', status: 'ready' },
            { id: 'multicode-mobile', root: '../multicode-mobile', branch: 'sprintengine/team-1', status: 'ready' },
          ],
        },
      },
    ],
    workspaces: [
      {
        workspaceId: `sprintengine:${root}`,
        kind: 'sprintengine',
        name: 'Sprint Engine',
        workspacePath: root,
        statePath: join(root, '.multi-code', 'sprintengine'),
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
  const safe = sanitizeMobileSnapshotForRelay(buildSnapshotFixture(root))

  // The whole payload must be free of local paths — this is exactly what the
  // relay rejects.
  assert.equal(localPathProbe.test(JSON.stringify(safe)), false, 'sanitized snapshot must contain no local path')

  // The sanitized snapshot must still pass the same validator the phone runs on
  // receipt (e.g. workspacePath/statePath must be non-empty). This is the guard
  // that catches over-aggressive blanking.
  const validation = validateMobileControlSnapshot(safe)
  assert.equal(validation.ok, true, validation.ok === false ? validation.error.message : undefined)

  // Sprint Engine paths are display-only / server-resolved, but must stay
  // non-empty and relay-safe.
  assert.equal(safe.sprintEngines[0].workspacePath, 'projA', 'board name comes from the folder basename')
  assert.equal(isWorkspaceIdToken(safe.sprintEngines[0].statePath), true, 'statePath redacted to a non-empty relay-safe token')
  assert.equal(localPathProbe.test(safe.sprintEngines[0].statePath), false)

  // MC-1613: the multi-repo projects reach the phone through the same pass, and the
  // sanitizer must neither reshape nor redact them — their roots are relative, so
  // there is nothing local to strip and every field is what the phone renders.
  assert.deepEqual(safe.sprintEngines[0].vcs?.repos, [
    { id: 'primary', root: '.', branch: 'sprintengine/team-1', status: 'ready' },
    { id: 'multicode-mobile', root: '../multicode-mobile', branch: 'sprintengine/team-1', status: 'ready' },
  ], 'declared projects survive the relay copy intact')

  // Backlog workspacePath round-trips for create/start, so it must be a
  // resolvable token, and resolve back to the original root.
  const backlogToken = safe.backlog?.[0]?.workspacePath
  assert.equal(isWorkspaceIdToken(backlogToken ?? ''), true)
  assert.equal(resolveWorkspaceIdToRoot(backlogToken ?? '', [root]), resolve(root))
  assert.equal(safe.backlog?.[0]?.workspaceName, 'projA', 'display name preserved')
}

// Guards the on-demand path (workspace open / backlog refresh -> snapshot.request
// command) which builds its result outside the publish emit() chokepoint. This is
// the exact path that surfaced "must not include local paths at
// summary.data.sprintEngines[0].workspacePath".
async function assertOnDemandSnapshotIsSanitized(): Promise<void> {
  const root = '/Users/example/workspace/projC'
  const fixture = buildSnapshotFixture(root)
  const result = await dispatchSnapshotRequest({
    command: { type: 'snapshot.request', commandId: 'c1', deviceId: 'd1', payload: {} } as never,
    snapshotService: { readSnapshot: async () => fixture } as never,
    desktopSessionId: 'sess',
    statePathsProvider: async () => [],
  })
  assert.equal(
    localPathProbe.test(JSON.stringify(result)),
    false,
    'on-demand snapshot.request result must contain no local path'
  )
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
