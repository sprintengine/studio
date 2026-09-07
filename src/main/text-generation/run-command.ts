// One child process, prompt on stdin, collected to completion or killed at
// the deadline. Kept apart from the service so tests can substitute the run
// and the service's own logic (probe, temp files, parse, guardrail) runs for
// real against a fake CLI.

import { spawn } from 'node:child_process'

export type CommandRunInput = {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  stdin: string
  timeoutMs: number
}

export type CommandRun = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Set when the process never started (ENOENT, EACCES); `code` is then null. */
  spawnError: string | null
}

export type RunCommand = (input: CommandRunInput) => Promise<CommandRun>

export const runCommand: RunCommand = (input) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const settle = (run: CommandRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(run)
    }
    const child = spawn(input.file, input.args, {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, input.timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      settle({ code: null, stdout, stderr, timedOut, spawnError: error.message || String(error) })
    })
    child.on('close', (code) => {
      settle({ code, stdout, stderr, timedOut, spawnError: null })
    })
    // A closed stdin is what tells `claude -p` and `codex exec -` the prompt
    // is complete; without `end()` both wait forever.
    child.stdin?.on('error', () => {
      // EPIPE when the CLI exits before reading (bad flag, auth refusal): the
      // exit code and stderr carry the story, so the write error is noise.
    })
    child.stdin?.end(input.stdin)
  })
