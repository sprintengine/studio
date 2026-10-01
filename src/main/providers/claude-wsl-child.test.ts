import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { spawnWslClaude, wslClaudeLaunchArgs } from './claude-wsl-child'

// The script `wsl.exe` would hand to bash, run here by this machine's bash:
// everything after `--exec` is what the distribution runs.
function runInsideBash(args: string[], home: string, stdin: string) {
  const exec = args.indexOf('--exec')
  const [file, ...rest] = args.slice(exec + 1)
  return spawnSync(file, rest, {
    input: stdin,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
  })
}

describe('wslClaudeLaunchArgs', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('names the distribution and passes the script as one quote-free argument', () => {
    const args = wslClaudeLaunchArgs({
      distro: 'Ubuntu',
      cwd: '/home/dev/it\'s "here"',
      command: '/home/dev/.local/bin/claude',
      args: ['--model', 'opus', '--allowedTools', 'Bash(git log:*)'],
      env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', PATH: 'C:\\Windows' },
    })
    expect(args.slice(0, 7)).toEqual(['-d', 'Ubuntu', '--cd', '~', '--exec', 'bash', '-c'])
    expect(args).toHaveLength(8)
    expect(args[7]).not.toMatch(/["'%]/u)
  })

  it.skipIf(process.platform === 'win32')(
    "runs the command in the folder with the chat's variables, and keeps a noisy profile off stdout",
    () => {
      const home = mkdtempSync(join(tmpdir(), 'wsl-child-'))
      dirs.push(home)
      const folder = join(home, "a folder with 'quotes'")
      spawnSync('mkdir', ['-p', folder])
      // A profile that talks, reads stdin and moves away: none of it may reach
      // the command's stdout or eat the command's stdin.
      writeFileSync(join(home, '.bash_profile'), 'echo hello from profile\nread -t 1 _ || true\ncd /\n')
      const fake = join(home, 'claude')
      writeFileSync(
        fake,
        '#!/bin/sh\nprintf "cwd=%s\\n" "$(pwd)"\nprintf "arg=%s\\n" "$@"\nprintf "entry=%s\\n" "$CLAUDE_CODE_ENTRYPOINT"\nprintf "path=%s\\n" "${WINPATH:-unset}"\nprintf "sock=%s\\n" "$SPRINTENGINE_AGENT_STATE_SOCKET"\ncat\n',
      )
      chmodSync(fake, 0o755)
      const args = wslClaudeLaunchArgs({
        distro: 'Ubuntu',
        cwd: folder,
        command: fake,
        args: ['--model', 'opus', 'two  spaces', '$HOME', '*', 'line\nbreak'],
        env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', WINPATH: 'C:\\Windows' },
        agentStateSocketPath: '/run/user/1000/agent.sock',
      })
      const result = runInsideBash(args, home, '{"type":"user"}\n')
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(
        [
          `cwd=${folder}`,
          'arg=--model',
          'arg=opus',
          'arg=two  spaces',
          'arg=$HOME',
          'arg=*',
          'arg=line\nbreak',
          'entry=sdk-ts',
          'path=unset',
          'sock=/run/user/1000/agent.sock',
          '{"type":"user"}',
          '',
        ].join('\n'),
      )
      expect(result.stderr).toContain('hello from profile')
    },
  )
})

describe('spawnWslClaude', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  // The chat's `claude` starts the app's gateway (the SDK's `mcpServers`) with
  // its own environment, as it does in a terminal. Inside WSL that bridge
  // opens the helper's socket only with a token; this runs the shipped bridge
  // against a socket standing in for the helper's, and reads its first line.
  it.skipIf(process.platform === 'win32')(
    "hands the chat's token to the app's MCP bridge, which opens its channel with it",
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'wsl-gw-'))
      dirs.push(home)
      const socketPath = join(home, 'mcp.sock')
      const firstLine = new Promise<string>((done) => {
        const server = createServer((socket) => {
          let buffered = ''
          socket.on('data', (chunk) => {
            buffered += chunk.toString('utf8')
            const end = buffered.indexOf('\n')
            if (end < 0) return
            done(buffered.slice(0, end))
            socket.destroy()
            server.close()
          })
        }).listen(socketPath)
      })
      const info = join(home, 'info.json')
      writeFileSync(
        info,
        JSON.stringify({ socketPath, transport: 'unix-socket', pid: process.pid, channelAuth: 'launch-token' }),
      )
      const bridge = resolve('resources/automation/mcp-stdio-bridge.mjs')
      const fake = join(home, 'claude')
      writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${bridge}" --info-path "${info}"\n`)
      chmodSync(fake, 0o755)
      const issued: string[] = []
      const revoked: string[] = []
      const token = 'chat_token_0123456789abcdef'
      // What `wsl.exe` would run, run by this machine's bash.
      const local = ((_file: string, args: string[], options: { stdio: unknown }) => {
        const exec = args.indexOf('--exec')
        const [file, ...rest] = args.slice(exec + 1)
        return spawn(file, rest, { stdio: options.stdio as never, env: { PATH: process.env.PATH, HOME: home } })
      }) as unknown as typeof spawn
      const child = spawnWslClaude(
        {
          distro: 'Ubuntu',
          agentStateSocketPath: null,
          issueChannelToken: () => {
            issued.push(token)
            return { token, revoke: () => revoked.push(token) }
          },
        },
        { command: fake, args: ['--output-format', 'stream-json'], cwd: '', env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } },
        { spawn: local },
      )
      const closed = new Promise<void>((done) => child.once('close', () => done()))
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      child.stdout?.resume()
      // A bridge that is refused exits at once; that is the failure, not a hang.
      const line = await Promise.race([firstLine, closed.then(() => Promise.reject(new Error(stderr)))])
      expect(JSON.parse(line)).toEqual({ t: 'auth', token })
      child.stdin?.end()
      await closed
      expect(issued).toEqual([token])
      expect(revoked).toEqual([token])
    },
  )
})
