import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A real `sshd` in a container for the phase 8 integration suites (spec 9.3),
// run only with `STUDIO_TEST_DOCKER=1` and a Docker that answers. Each
// fixture has its own container, user key, `known_hosts` and ssh config with
// one `Host build-box` entry, which the suites pass with `-F` so the
// person's own config is never read.

export const DOCKER_TESTS = process.env.STUDIO_TEST_DOCKER === '1' && spawnSync('docker', ['info']).status === 0

const IMAGE = 'sprintengine-test-sshd:1'

let built = false
export function ensureSshdImage(): string {
  if (built) return IMAGE
  const found = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0
  if (!found)
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '-f', join(__dirname, 'sshd.Dockerfile'), __dirname], {
      stdio: 'pipe',
    })
  built = true
  return IMAGE
}

export type SshdFixture = {
  id: string
  port: number
  dir: string
  /** The `-F` config: `Host build-box` with this fixture's key and known_hosts. */
  configFile: string
  keyPath: string
  knownHosts: string
  /** A command in the container, as root, its stdout. */
  exec(command: string, user?: string): string
  pause(): void
  unpause(): void
  stop(): void
}

export type SshdOptions = {
  /** `sshd -o` lines: `AllowTcpForwarding no`, `AuthenticationMethods publickey,password`. */
  sshdOptions?: string[]
  /** A passphrase on the user key (asked through askpass). */
  passphrase?: string
  /** The home mounted noexec. */
  noexecHome?: boolean
  /** Extra lines for the client's Host entry. */
  clientLines?: string[]
}

export function startSshd(options: SshdOptions = {}): SshdFixture {
  const image = ensureSshdImage()
  const dir = mkdtempSync(join(tmpdir(), 'se-sshd-'))
  const keyPath = join(dir, 'id_ed25519')
  execFileSync('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    options.passphrase ?? '',
    '-C',
    'dev@example.com',
    '-f',
    keyPath,
  ])
  const args = ['run', '-d', '--rm', '-p', '127.0.0.1::22']
  if (options.noexecHome) args.push('--tmpfs', '/home/dev:rw,noexec,uid=1000,gid=1000,mode=0755')
  args.push(image, '/usr/sbin/sshd', '-D', '-e', ...(options.sshdOptions ?? []).flatMap((line) => ['-o', line]))
  const id = execFileSync('docker', args, { encoding: 'utf8' }).trim()
  const exec = (command: string, user = 'root') =>
    execFileSync('docker', ['exec', '-u', user, id, 'sh', '-c', command], { encoding: 'utf8' })
  if (options.noexecHome) exec('mkdir -p /home/dev/.ssh && chown -R dev:dev /home/dev && chmod 700 /home/dev/.ssh')
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      id,
      'sh',
      '-c',
      'cat > /home/dev/.ssh/authorized_keys && chown dev:dev /home/dev/.ssh/authorized_keys && chmod 600 /home/dev/.ssh/authorized_keys',
    ],
    { input: readFileSync(`${keyPath}.pub`) },
  )
  const port = Number(
    execFileSync('docker', ['port', id, '22/tcp'], { encoding: 'utf8' }).trim().split('\n')[0]!.split(':').at(-1),
  )
  const knownHosts = join(dir, 'known_hosts')
  const configFile = join(dir, 'ssh_config')
  writeFileSync(
    configFile,
    [
      'Host build-box',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      '  User dev',
      `  IdentityFile ${keyPath}`,
      '  IdentitiesOnly yes',
      `  UserKnownHostsFile ${knownHosts}`,
      ...(options.clientLines ?? []).map((line) => `  ${line}`),
      '',
    ].join('\n'),
  )
  // sshd answers a moment after the container starts.
  for (let attempt = 0; attempt < 50; attempt++) {
    const probe = spawnSync('ssh-keyscan', ['-p', String(port), '127.0.0.1'], { encoding: 'utf8', timeout: 2_000 })
    if (probe.stdout.includes('ssh-ed25519')) break
    spawnSync('sleep', ['0.2'])
  }
  return {
    id,
    port,
    dir,
    configFile,
    keyPath,
    knownHosts,
    exec,
    pause: () => void execFileSync('docker', ['pause', id]),
    unpause: () => void execFileSync('docker', ['unpause', id]),
    stop() {
      spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
