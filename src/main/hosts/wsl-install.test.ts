// Installing the helper and its Node into a distribution, run for real: the
// scripts go through `sh -s` and the archives through `tar` exactly as
// `wsl.exe --exec` hands them over, against a temporary home standing in for
// `/home/dev`. Only `wsl.exe` itself is missing.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import {
  buildAppPayload,
  buildCommitScript,
  buildLaunchScript,
  buildStageScript,
  buildTar,
  buildUnreadyScript,
  COMMITTED_MARKER,
  commitFailure,
  NEEDS_INSTALL_EXIT,
  parseNeedReport,
  STAGED_MARKER,
  tarArgs,
  WSL_DATA_REL,
} from './wsl-install'
import { WSL_NODE_VERSION, wslNodeArch, wslNodePackage, type WslNodePackage } from './wsl-node-runtime'
import { gzipSync } from 'node:zlib'

let temp = ''
let home = ''
const HAS_TAR = spawnSync('tar', ['--version']).status === 0

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-wsl-install-'))
  home = join(temp, 'home')
  mkdirSync(home)
})

afterAll(() => rmSync(temp, { recursive: true, force: true }))

function sh(script: string, env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-s'], {
    input: script,
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, ...env },
    encoding: 'utf8',
  })
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

// `wsl.exe -d X --cd ~ --exec tar …` with the archive on stdin.
function untar(argv: string[], archive: Buffer): number {
  const result = spawnSync(argv[0], argv.slice(1), { input: archive, cwd: home })
  return result.status ?? -1
}

// A stand-in for the Node archive: the same top directory and `bin/node`,
// which answers `--version` with the pinned version and otherwise runs this
// machine's Node, so the launch can start the real helper on it.
function fakeNodeArchive(pkg: WslNodePackage, version = WSL_NODE_VERSION): Buffer {
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nexec '${process.execPath}' "$@"\n`
  const tar = buildTar([
    { path: `${pkg.dirName}/bin/node`, data: Buffer.from(script) },
    { path: `${pkg.dirName}/lib/node_modules/npm/package.json`, data: Buffer.from('{}') },
  ])
  // The writer marks files 0600; an executable needs its bit, as the real
  // archive has it. Patch the mode field of the first file header.
  const withExec = Buffer.from(tar)
  const firstFile = withExec.indexOf(Buffer.from(`${pkg.dirName}/bin/node`))
  withExec.write('0000700\0', firstFile + 100, 8, 'ascii')
  let sum = 0
  withExec.write('        ', firstFile + 148, 8, 'ascii')
  for (let index = firstFile; index < firstFile + 512; index += 1) sum += withExec[index]
  withExec.write(`${sum.toString(8).padStart(6, '0')}\0 `, firstFile + 148, 8, 'ascii')
  return gzipSync(withExec)
}

function install(kind: 'node' | 'app', archive: Buffer, digest: string, pkg?: WslNodePackage) {
  const id = `t${Math.random().toString(16).slice(2, 10)}`
  const staged = sh(buildStageScript(id))
  assert.ok(staged.stdout.includes(STAGED_MARKER), staged.stderr)
  const argv = kind === 'node' && pkg ? tarArgs('node', id, pkg) : tarArgs('app', id)
  assert.equal(untar(argv, archive), 0, `tar ${argv.join(' ')}`)
  return sh(
    buildCommitScript(
      kind === 'node'
        ? { kind: 'node', stageId: id, digest }
        : { kind: 'app', stageId: id, digest, appVersion: '0.4.0' },
    ),
  )
}

const payload = () =>
  buildAppPayload([
    {
      dir: join(process.cwd(), 'resources', 'wsl-helper'),
      into: 'wsl-helper',
      filter: (path) => path.endsWith('.mjs'),
    },
    { dir: join(process.cwd(), 'resources', 'hooks'), into: 'hooks', filter: (path) => path.endsWith('.mjs') },
    {
      dir: join(process.cwd(), 'resources', 'automation'),
      into: 'automation',
      filter: (path) => path === 'mcp-stdio-bridge.mjs',
    },
  ])

test('the architecture and archive choice follow what the distribution reports', () => {
  assert.equal(wslNodeArch('x86_64\n'), 'x64')
  assert.equal(wslNodeArch('aarch64'), 'arm64')
  assert.equal(wslNodeArch('armv7l'), null)
  const pkg = wslNodePackage('x64', 'xz')
  assert.equal(pkg.url, `https://nodejs.org/dist/${WSL_NODE_VERSION}/node-${WSL_NODE_VERSION}-linux-x64.tar.xz`)
  assert.match(pkg.sha256, /^[a-f0-9]{64}$/u)
  assert.deepEqual(tarArgs('node', 'abc', pkg), [
    'tar',
    '-xJf',
    '-',
    '-C',
    `${WSL_DATA_REL}/.stage/abc`,
    '--strip-components=1',
    `node-${WSL_NODE_VERSION}-linux-x64/bin/node`,
  ])
  for (const arg of tarArgs('node', 'abc', pkg)) {
    assert.doesNotMatch(arg, /[\s'"$`\\]/u, 'nothing wsl.exe could mangle crosses its command line')
  }
  assert.throws(() => buildStageScript("x'; rm -rf ~"), /plain token/u)
  assert.throws(
    () => buildLaunchScript({ appVersion: '0.4.0', nodeDigests: ['zz'], appDigest: 'ab', profile: 'p' }),
    /hex/u,
  )
})

test('the app payload is the same bytes from the same files, and holds the helper, hooks and bridge', () => {
  const first = payload()
  const second = payload()
  assert.equal(first.digest, second.digest)
  assert.ok(first.tarGz.equals(second.tarGz))
})

test.skipIf(!HAS_TAR)(
  'a fresh distribution is told what to install, installs it atomically, and then runs the helper',
  async () => {
    const pkg: WslNodePackage = { ...wslNodePackage('x64', 'gz'), sha256: 'c'.repeat(64) }
    const app = payload()
    const launch = buildLaunchScript({
      appVersion: '0.4.0',
      nodeDigests: [pkg.sha256],
      appDigest: app.digest,
      profile: 'abc123def456',
    })
    const first = sh(launch)
    assert.equal(first.code, NEEDS_INSTALL_EXIT)
    const needs = parseNeedReport(first.stdout)
    assert.ok(needs)
    assert.equal(needs.node, true)
    assert.equal(needs.app, true)
    assert.ok(needs.arch.length > 0)

    // An old runtime nothing runs from is pruned by the next install.
    const old = join(home, WSL_DATA_REL, 'runtime', 'node-v1.0.0')
    mkdirSync(join(old, 'bin'), { recursive: true })

    const node = install('node', fakeNodeArchive(pkg), pkg.sha256, pkg)
    assert.ok(node.stdout.includes(COMMITTED_MARKER), `${node.stdout}${node.stderr}`)
    const runtime = join(home, WSL_DATA_REL, 'runtime', `node-${WSL_NODE_VERSION}`)
    assert.equal(readFileSync(join(runtime, '.ready'), 'utf8'), pkg.sha256)
    assert.ok(existsSync(join(runtime, 'bin', 'node')))
    assert.ok(!existsSync(join(runtime, 'lib')), 'only the binary is unpacked')
    assert.ok(!existsSync(old), 'the unused old runtime is pruned')

    const appInstall = install('app', app.tarGz, app.digest)
    assert.ok(appInstall.stdout.includes(COMMITTED_MARKER), `${appInstall.stdout}${appInstall.stderr}`)
    assert.ok(existsSync(join(home, WSL_DATA_REL, '0.4.0', 'wsl-helper', 'helper.mjs')))
    assert.ok(existsSync(join(home, WSL_DATA_REL, '0.4.0', 'hooks', 'sprintengine-agent-state.mjs')))
    assert.ok(existsSync(join(home, WSL_DATA_REL, '0.4.0', 'automation', 'mcp-stdio-bridge.mjs')))
    assert.deepEqual(
      spawnSync('ls', [join(home, WSL_DATA_REL, '.stage')], { encoding: 'utf8' }).stdout.trim(),
      '',
      'no staging directory is left behind',
    )

    // Installed: the launch script now execs the helper, which says `boot`.
    const child = spawn('sh', ['-s'], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, SPRINTENGINE_HELPER_SOCKET_BASE: join(temp, 'rt') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.write(`${launch}\n`)
    const boot = await new Promise<string>((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
        if (out.includes('\n')) resolve(out.split('\n')[0])
      })
      child.on('close', (code) => reject(new Error(`exited ${code}: ${out}`)))
    })
    assert.equal((JSON.parse(boot) as { t: string }).t, 'boot')
    child.stdin.end()
    await new Promise((resolve) => child.on('close', resolve))

    // The same install again changes nothing and still succeeds.
    const again = install('node', fakeNodeArchive(pkg), pkg.sha256, pkg)
    assert.ok(again.stdout.includes(COMMITTED_MARKER))

    // A launch probe that failed drops the Node marker, so the next start installs again.
    sh(buildUnreadyScript())
    assert.equal(parseNeedReport(sh(launch).stdout)?.node, true)
  },
)

test.skipIf(!HAS_TAR)(
  'a Node that does not run, or reports another version, is refused and leaves nothing behind',
  () => {
    const pkg: WslNodePackage = { ...wslNodePackage('arm64', 'gz'), sha256: 'd'.repeat(64) }
    const failed = install('node', fakeNodeArchive(pkg, 'v1.2.3'), pkg.sha256, pkg)
    assert.equal(commitFailure(failed.stdout, failed.stderr), 'node-version v1.2.3')
    const marker = join(home, WSL_DATA_REL, 'runtime', `node-${WSL_NODE_VERSION}`, '.ready')
    assert.notEqual(
      existsSync(marker) ? readFileSync(marker, 'utf8') : null,
      pkg.sha256,
      'the refused Node is not marked',
    )
    assert.equal(
      spawnSync('ls', [join(home, WSL_DATA_REL, '.stage')], { encoding: 'utf8' }).stdout.trim(),
      '',
      'its staging directory is gone',
    )
  },
)

test.skipIf(!HAS_TAR)('a tree set aside while in use is kept until nothing runs from its old path', () => {
  // A stand-in /proc (macOS has none): one process running the helper of the
  // installed 0.4.0, by the path it was started from.
  const base = join(home, WSL_DATA_REL)
  const fakeProc = join(temp, 'fake-proc')
  const running = join(fakeProc, '4242')
  mkdirSync(running, { recursive: true })
  writeFileSync(join(running, 'cmdline'), `node\0${base}/0.4.0/wsl-helper/helper.mjs\0`)
  const commit = (digest: string) => {
    const id = `t${Math.random().toString(16).slice(2, 10)}`
    assert.ok(sh(buildStageScript(id)).stdout.includes(STAGED_MARKER))
    assert.equal(untar(tarArgs('app', id), payload().tarGz), 0)
    const script = buildCommitScript({ kind: 'app', stageId: id, digest, appVersion: '0.4.0' })
    assert.ok(script.includes('/proc/[0-9]*/cmdline'))
    const result = sh(script.replace('/proc/[0-9]*/cmdline', `${fakeProc}/[0-9]*/cmdline`))
    assert.ok(result.stdout.includes(COMMITTED_MARKER), `${result.stdout}${result.stderr}`)
  }
  const setAside = () => readdirSync(base).filter((name) => name.startsWith('0.4.0.old-'))

  // Whatever an earlier case left, set aside or not, goes first.
  for (const name of setAside()) rmSync(join(base, name), { recursive: true, force: true })
  rmSync(join(base, '0.4.0'), { recursive: true, force: true })
  commit('a1'.repeat(32))
  assert.deepEqual(setAside(), [], 'nothing was there to set aside')
  // The same version with another payload (a dev build), while the helper
  // runs from it: the tree it runs from is set aside, not deleted.
  commit('b2'.repeat(32))
  assert.equal(setAside().length, 1, `set aside while the old helper still runs from it: ${readdirSync(base)}`)
  assert.ok(existsSync(join(base, setAside()[0], 'wsl-helper', 'helper.mjs')), 'whole')
  // Another commit while it still runs: kept, because its processes name the
  // old path and not the set-aside one.
  commit('b2'.repeat(32))
  assert.equal(setAside().length, 1, 'still kept')
  // Nothing runs from it any more: the next commit prunes it.
  rmSync(running, { recursive: true, force: true })
  commit('b2'.repeat(32))
  assert.deepEqual(setAside(), [])
  assert.ok(existsSync(join(base, '0.4.0', 'wsl-helper', 'helper.mjs')), 'the current tree stays')
})

test.skipIf(!existsSync('/proc/self/cmdline'))('pruning skips a runtime a running process still uses', async () => {
  const live = join(home, WSL_DATA_REL, 'runtime', 'node-v2.0.0')
  mkdirSync(join(live, 'bin'), { recursive: true })
  const binary = join(live, 'bin', 'sleeper')
  writeFileSync(binary, '#!/bin/sh\nsleep 30\n')
  chmodSync(binary, 0o755)
  const running = spawn(binary, [], { stdio: 'ignore' })
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const pkg: WslNodePackage = { ...wslNodePackage('x64', 'gz'), sha256: 'e'.repeat(64) }
    const result = install('node', fakeNodeArchive(pkg), pkg.sha256, pkg)
    assert.ok(result.stdout.includes(COMMITTED_MARKER))
    assert.ok(existsSync(live), 'a runtime in use is left alone')
  } finally {
    running.kill('SIGKILL')
  }
})
