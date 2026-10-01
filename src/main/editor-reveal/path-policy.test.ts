import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { nodePathPolicyFs } from './editor-tool-backends'
import {
  classifyAgentPath,
  displayPathFor,
  isInsideComparable,
  isSensitivePath,
  resolveAgentPath,
  type PathTrust,
} from './path-policy'

// A real directory tree, because the case that matters most — a symlink inside
// the workspace that leads out of it — is only honest against a real
// `realpath`.
let root = ''
let workspace = ''
let outside = ''
let home = ''
let userData = ''

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'editor-reveal-policy-')))
  workspace = join(root, 'workspace')
  outside = join(root, 'elsewhere')
  home = join(root, 'home')
  userData = join(root, 'user-data')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(join(home, '.ssh'), { recursive: true })
  await mkdir(userData, { recursive: true })
  await writeFile(join(workspace, 'src', 'a.ts'), 'one\ntwo\nthree\n')
  await writeFile(join(outside, 'notes.txt'), 'outside\n')
  await writeFile(join(outside, 'fix.patch'), 'diff --git a/x b/x\n+y\n')
  await writeFile(join(outside, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 5]))
  await writeFile(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY\n')
  await writeFile(join(userData, 'settings.json'), '{}\n')
  // Inside the workspace by name, outside it in fact.
  await symlink(join(home, '.ssh', 'id_ed25519'), join(workspace, 'innocent.txt'))
  await symlink(join(outside, 'notes.txt'), join(workspace, 'notes-link.txt'))
  // A path the agent wrote, since swapped for a link to something it did not.
  await symlink(join(outside, 'notes.txt'), join(outside, 'swapped.patch'))
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

function trust(overrides: Partial<PathTrust> = {}): PathTrust {
  return {
    trustedRoots: [workspace],
    agentWritten: new Set<string>(),
    remote: false,
    homeDir: home,
    userDataDir: userData,
    ...overrides,
  }
}

test('a file inside the workspace opens, with its line count', async () => {
  const verdict = await classifyAgentPath(join(workspace, 'src', 'a.ts'), trust(), nodePathPolicyFs)
  assert.equal(verdict.status, 'opened')
  assert.equal(verdict.status === 'opened' && verdict.lineCount, 3)
  assert.equal(verdict.status === 'opened' && verdict.tier, 'workspace')
})

test('a file outside everything waits for the owner', async () => {
  const verdict = await classifyAgentPath(join(outside, 'notes.txt'), trust(), nodePathPolicyFs)
  assert.equal(verdict.status, 'awaiting_owner')
})

test('a file outside that this agent wrote opens without asking', async () => {
  const patch = join(outside, 'fix.patch')
  const verdict = await classifyAgentPath(patch, trust({ agentWritten: new Set([patch]) }), nodePathPolicyFs)
  assert.equal(verdict.status, 'opened')
  assert.equal(verdict.status === 'opened' && verdict.tier, 'agent_written')
})

test('a paired device gets the workspace tier only: agent-written and outside are refused', async () => {
  const patch = join(outside, 'fix.patch')
  const written = await classifyAgentPath(
    patch,
    trust({ agentWritten: new Set([patch]), remote: true }),
    nodePathPolicyFs,
  )
  assert.equal(written.status, 'refused')
  assert.equal(written.status === 'refused' && written.reason, 'outside_workspace')
  const inside = await classifyAgentPath(join(workspace, 'src', 'a.ts'), trust({ remote: true }), nodePathPolicyFs)
  assert.equal(inside.status, 'opened')
})

test('a symlink in the workspace that leads to a credential store is refused, not opened', async () => {
  const verdict = await classifyAgentPath(join(workspace, 'innocent.txt'), trust(), nodePathPolicyFs)
  assert.equal(verdict.status, 'refused')
  assert.equal(verdict.status === 'refused' && verdict.reason, 'sensitive_path')
})

test('a symlink in the workspace that leads outside it is judged where it lands', async () => {
  const verdict = await classifyAgentPath(join(workspace, 'notes-link.txt'), trust(), nodePathPolicyFs)
  assert.equal(verdict.status, 'awaiting_owner')
})

test('credential stores and the app data folder are refused whoever wrote them', async () => {
  const key = join(home, '.ssh', 'id_ed25519')
  const direct = await classifyAgentPath(
    key,
    trust({ agentWritten: new Set([key]), trustedRoots: [home] }),
    nodePathPolicyFs,
  )
  assert.equal(direct.status === 'refused' && direct.reason, 'sensitive_path')
  const appData = await classifyAgentPath(
    join(userData, 'settings.json'),
    trust({ trustedRoots: [root] }),
    nodePathPolicyFs,
  )
  assert.equal(appData.status === 'refused' && appData.reason, 'sensitive_path')
  // Other people's homes, and a Linux home inside a distribution, too.
  assert.equal(isSensitivePath('/Users/dev/.aws/credentials', { homeDir: '/Users/me', userDataDir: '' }), true)
  assert.equal(isSensitivePath('/home/dev/.config/gh/hosts.yml', { homeDir: '', userDataDir: '' }), true)
  assert.equal(isSensitivePath('//wsl.localhost/Ubuntu/home/dev/.netrc', { homeDir: '', userDataDir: '' }), true)
  assert.equal(
    isSensitivePath('/Users/dev/Library/Keychains/login.keychain-db', { homeDir: '', userDataDir: '' }),
    true,
  )
  assert.equal(isSensitivePath('/Users/dev/project/src/ssh.ts', { homeDir: '/Users/dev', userDataDir: '' }), false)
})

test('missing, binary and folder paths are refused with their reason', async () => {
  const missing = await classifyAgentPath(join(workspace, 'nope.ts'), trust(), nodePathPolicyFs)
  assert.equal(missing.status === 'refused' && missing.reason, 'not_found')
  const binary = await classifyAgentPath(
    join(outside, 'blob.bin'),
    trust({ trustedRoots: [outside] }),
    nodePathPolicyFs,
  )
  assert.equal(binary.status === 'refused' && binary.reason, 'binary')
  const folder = await classifyAgentPath(join(workspace, 'src'), trust(), nodePathPolicyFs)
  assert.equal(folder.status === 'refused' && folder.reason, 'not_found')
})

test('relative paths resolve against the agent working directory; ~ against home', () => {
  const resolved = resolveAgentPath('src/a.ts', { cwd: '/Users/dev/repo', wsl: null, homeDir: '/Users/dev' })
  assert.deepEqual(resolved, {
    ok: true,
    value: { path: '/Users/dev/repo/src/a.ts', displayPath: '/Users/dev/repo/src/a.ts' },
  })
  const tilde = resolveAgentPath('~/notes.md', { cwd: null, wsl: null, homeDir: '/Users/dev' })
  assert.equal(tilde.ok && tilde.value.path, '/Users/dev/notes.md')
  const orphan = resolveAgentPath('src/a.ts', { cwd: null, wsl: null, homeDir: '/Users/dev' })
  assert.equal(orphan.ok, false)
})

test('WSL: Linux paths convert to the Windows spelling and keep the Linux one for display', () => {
  const context = {
    cwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
    wsl: { distro: 'Ubuntu' },
    homeDir: 'C:\\Users\\dev',
  }
  const absolute = resolveAgentPath('/home/dev/repo/src/a.ts', context)
  assert.deepEqual(absolute, {
    ok: true,
    value: { path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo\\src\\a.ts', displayPath: '/home/dev/repo/src/a.ts' },
  })
  // Relative is joined in LINUX form onto the Linux spelling of the cwd.
  const relative = resolveAgentPath('../other/b.ts', context)
  assert.deepEqual(relative, {
    ok: true,
    value: { path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\other\\b.ts', displayPath: '/home/dev/other/b.ts' },
  })
  // A Windows drive seen from Linux.
  const mounted = resolveAgentPath('/mnt/c/work/fix.patch', { ...context, wsl: { distro: null } })
  assert.equal(mounted.ok && mounted.value.path, 'C:\\work\\fix.patch')
  // Without the distribution a distribution path has no Windows spelling.
  assert.equal(resolveAgentPath('/tmp/fix.patch', { ...context, wsl: { distro: null } }).ok, false)
  // And the two spellings of one WSL folder compare as one.
  assert.equal(
    isInsideComparable('\\\\wsl$\\Ubuntu\\home\\dev\\repo', '\\\\wsl.localhost\\ubuntu\\home\\dev\\repo\\src\\a.ts'),
    true,
  )
})

test('display paths are workspace-relative inside it and the agent spelling outside', () => {
  assert.equal(
    displayPathFor({ path: '/Users/dev/repo/src/a.ts', displayPath: '/Users/dev/repo/src/a.ts' }, '/Users/dev/repo'),
    'src/a.ts',
  )
  assert.equal(
    displayPathFor({ path: '/tmp/fix.patch', displayPath: '/tmp/fix.patch' }, '/Users/dev/repo'),
    '/tmp/fix.patch',
  )
})

test('a path the agent wrote that now links elsewhere is not "what it wrote"', async () => {
  const swapped = join(outside, 'swapped.patch')
  const verdict = await classifyAgentPath(swapped, trust({ agentWritten: new Set([swapped]) }), nodePathPolicyFs)
  assert.equal(verdict.status, 'awaiting_owner')
})
