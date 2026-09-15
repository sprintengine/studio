import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'sprint-engine-launch-contrib-'))

const moduleWithLoad = Module as typeof Module & {
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown
}
const originalLoad = moduleWithLoad._load
moduleWithLoad._load = function loadWithElectronStub(
  request: string,
  parent: NodeModule | null,
  isMain: boolean
): unknown {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: (name: string) => (name === 'userData' ? userData : join(userData, name)),
      },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

const { contributeSprintEngineLaunch } = require('./sprint-engine-launch-contribution') as typeof import('./sprint-engine-launch-contribution')

function main(): void {
  const withState = contributeSprintEngineLaunch({
    cli: 'claude-code',
    workspaceRoot: '/Users/dev/project',
    sessionId: 'session-1',
    pathStyle: 'posix',
    statePath: '/Users/dev/project/.sprintengine/sprintengine/run.yaml',
    knowledgeRoot: '/Users/dev/project/knowledge',
  })

  assert.equal(
    withState.env?.SPRINTENGINE_STATE_PATH,
    '/Users/dev/project/.sprintengine/sprintengine/run.yaml'
  )
  assert.equal(withState.env?.SPRINTENGINE_KNOWLEDGE_ROOT, '/Users/dev/project/knowledge')
  assert.equal(
    withState.env?.SPRINTENGINE_REPO_TOOL_PATH,
    '/Users/dev/project/.agents/skills/sprintengine/scripts/sprintengine_tool.py'
  )
  assert.deepEqual(withState.session, { managed: true })
  assert.deepEqual(withState.identityKeys, ['SPRINTENGINE_REGISTRY_ROOTS'])
  assert.ok(
    withState.pathEntries?.some((entry) => entry.endsWith('tool-bin')),
    `shim directory is on PATH: ${JSON.stringify(withState.pathEntries)}`
  )

  const bootstrap = withState.shellFunctions?.join('\n') ?? ''
  assert.match(bootstrap, /sprintengine\(\) \{/)
  assert.match(bootstrap, /souls\(\) \{/)
  assert.match(bootstrap, /export -f souls/)
  assert.match(bootstrap, /-m souls/)

  const plain = contributeSprintEngineLaunch({
    cli: 'codex',
    workspaceRoot: '/Users/dev/project',
    sessionId: 'plain',
    pathStyle: 'posix',
  })
  assert.equal(plain.env?.SPRINTENGINE_STATE_PATH, undefined)
  assert.deepEqual(plain.session, { managed: false })
  const plainBootstrap = plain.shellFunctions?.join('\n') ?? ''
  assert.match(plainBootstrap, /souls\(\) \{/, 'plain launches still carry the souls shim until MC-2512')

  console.log('sprint-engine-launch-contribution tests passed')
}

main()
