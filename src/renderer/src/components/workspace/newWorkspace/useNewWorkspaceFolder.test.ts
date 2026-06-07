import assert from 'node:assert/strict'
import { scanSourceFiles } from './useNewWorkspaceFolder'

type Entry = { name: string; isDir: boolean }

const fixture = new Map<string, Entry[]>([
  ['/repo/backlog', [
    { name: 'product.md', isDir: false },
    { name: 'mockup.html', isDir: false },
    { name: 'nested', isDir: true },
    { name: 'node_modules', isDir: true },
  ]],
  ['/repo/backlog/nested', [
    { name: 'implementation.htm', isDir: false },
  ]],
  ['/repo/backlog/node_modules', [
    { name: 'ignored.md', isDir: false },
  ]],
  ['/repo/future-plans', [
    { name: 'legacy.md', isDir: false },
  ]],
  ['/repo', [
    { name: 'root-plan.md', isDir: false },
    { name: 'root-mockup.html', isDir: false },
    { name: 'backlog', isDir: true },
    { name: 'future-plans', isDir: true },
  ]],
])

Object.defineProperty(globalThis, 'window', {
  value: {
    api: {
      async readdir(path: string): Promise<Entry[]> {
        return fixture.get(normalize(path)) ?? []
      },
    },
  },
  configurable: true,
})

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '')
}

async function main(): Promise<void> {
  const plans = await scanSourceFiles('/repo')

  assert.deepEqual(
    plans.map((plan) => plan.relativePath),
    [
      'backlog/mockup.html',
      'backlog/nested/implementation.htm',
      'backlog/product.md',
    ],
    'source discovery returns only active backlog markdown/html sources',
  )
  assert.equal(
    plans.some((plan) => plan.relativePath.startsWith('future-plans/')),
    false,
    'legacy future-plans files are not active source-plan options',
  )
  assert.equal(
    plans.some((plan) => plan.relativePath === 'root-plan.md' || plan.relativePath === 'root-mockup.html'),
    false,
    'workspace-root markdown/html files are not active source-plan options',
  )

  console.log('useNewWorkspaceFolder.test.ts: ok')
}

void main()
