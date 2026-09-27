import assert from 'node:assert/strict'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { deriveWorkspaceId, isWorkspaceIdToken, resolveWorkspaceIdToRoot } from './workspace-id'
import { sanitizeMobileSnapshotForTransport, type MobileControlSnapshot } from './snapshot'
import { validateMobileWorkspacePath } from './workspace'
import { mobileControlProtocolVersion, validateMobileControlSnapshot } from './protocol'
import { test } from 'vitest'

test('workspace-id', async () => {
  // The same families of absolute path path-safety.ts redacts:
  // the sanitized snapshot must contain none of these.
  const localPathProbe =
    /(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/Volumes\/|\/Applications\/|\/Library\/|\/opt\/|\/srv\/|\/mnt\/|\/tmp\/|[A-Za-z]:\\|\\\\[^\\\s]+\\)/u

  const suiteRun = main()

  async function main(): Promise<void> {
    assertTokenRoundTrips()
    assertSanitizerStripsLocalPaths()
    await assertValidateResolvesToken()
    console.log('workspace-id regression: all assertions passed')
  }

  function buildSnapshotFixture(root: string): MobileControlSnapshot {
    return {
      protocolVersion: mobileControlProtocolVersion,
      generatedAt: '2026-06-27T00:00:00.000Z',
      desktopSessionId: 'sess',
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
    assert.equal(localPathProbe.test(token), false, 'token must carry no local path')
    assert.equal(resolveWorkspaceIdToRoot(token, [root]), resolve(root))
    // Stable: same root always hashes to the same token.
    assert.equal(deriveWorkspaceId(root), token)
    // Fail closed when no candidate matches.
    assert.equal(resolveWorkspaceIdToRoot(token, ['/Users/example/workspace/projB']), null)
    assert.equal(resolveWorkspaceIdToRoot('ws_notarealtoken', [root]), null)
  }

  function assertSanitizerStripsLocalPaths(): void {
    const root = '/Users/example/workspace/projA'
    const safe = sanitizeMobileSnapshotForTransport(buildSnapshotFixture(root))

    // The whole payload must be free of local paths before it leaves the desktop.
    assert.equal(localPathProbe.test(JSON.stringify(safe)), false, 'sanitized snapshot must contain no local path')

    // The sanitized snapshot must still pass the same validator the phone runs on
    // receipt (e.g. a backlog workspacePath must be non-empty). This is the guard
    // that catches over-aggressive blanking.
    const validation = validateMobileControlSnapshot(safe)
    assert.equal(validation.ok, true, validation.ok === false ? validation.error.message : '')

    assert.equal(Object.hasOwn(safe, 'sprintEngines'), false)

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
      /not available/u,
    )
  }

  await suiteRun
})
