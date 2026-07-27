import assert from 'node:assert/strict'
import {
  classifyChildProcess,
  collectChildProcessMetrics,
  parsePsProcessRows,
  sampleChildProcessMetrics,
} from './child-process-metrics'

async function run(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const PS_OUTPUT = `
  100     1  150000   2.5 /Electron        /app/Electron .
  101   100  700000   5.1 /Electron        /app/Electron Helper --type=renderer
  102   100     700   0.0 /bin/zsh         /bin/zsh -l /Users/test/Library/Application Support/multicode/terminal-startup/session.sh
  103   102  260000  12.4 claude           claude --permission-mode bypassPermissions long prompt text
  104   103   42000   1.2 npm              npm exec @playwright/mcp@latest
  105   104   31000   0.8 node             node /tmp/node_modules/.bin/playwright-mcp
  106   100   28000   0.3 /Python          /opt/homebrew/bin/python -m sprintengine_mcp --http --port 0
  107   100   90000   3.3 codex            codex --dangerously-bypass-approvals-and-sandbox resume
`

async function main(): Promise<void> {
  await run('parses ps rows with pid, parent, rss, cpu, command, and args', () => {
    const rows = parsePsProcessRows(PS_OUTPUT)
    assert.equal(rows.length, 8)
    assert.deepEqual(rows[2], {
      pid: 102,
      ppid: 100,
      rssKb: 700,
      cpuPercent: 0,
      command: '/bin/zsh',
      args: '/bin/zsh -l /Users/test/Library/Application Support/multicode/terminal-startup/session.sh',
    })
    assert.equal(rows[3].cpuPercent, 12.4)
  })

  await run('collects descendants, excludes Electron rows, and returns sanitized labels', () => {
    const rows = parsePsProcessRows(PS_OUTPUT)
    const metrics = collectChildProcessMetrics(rows, 100, new Set([100, 101]))
    const byPid = new Map(metrics.map((metric) => [metric.pid, metric]))

    assert.equal(byPid.has(101), false, 'Electron app metric rows are not duplicated')
    assert.equal(byPid.get(102)!.kind, 'terminal')
    assert.equal(byPid.get(102)!.name, 'Terminal shell')
    assert.equal(byPid.get(103)!.kind, 'agent')
    assert.equal(byPid.get(103)!.name, 'Claude CLI')
    assert.equal(byPid.get(103)!.type, 'Child')
    assert.equal(byPid.get(103)!.memoryBytes, 260000 * 1024)
    assert.equal(byPid.get(104)!.name, 'Playwright MCP')
    assert.equal(byPid.get(105)!.name, 'Playwright MCP')
    assert.equal(byPid.get(106)!.name, 'Sprint Engine MCP')
    assert.equal(byPid.get(107)!.name, 'Codex CLI')
    assert.equal(JSON.stringify(metrics).includes('long prompt text'), false)
  })

  await run('sampleChildProcessMetrics degrades to empty on unsupported platforms', async () => {
    const metrics = await sampleChildProcessMetrics(100, [], {
      platform: 'win32',
      runPs: async () => PS_OUTPUT,
    })
    assert.deepEqual(metrics, [])
  })

  await run('sampleChildProcessMetrics uses injected ps output on supported platforms', async () => {
    const metrics = await sampleChildProcessMetrics(100, [101], {
      platform: 'darwin',
      runPs: async () => PS_OUTPUT,
    })
    assert.equal(metrics.some((metric) => metric.name === 'Claude CLI'), true)
  })

  await run('headless SDK sessions (stream-json) classify as Claude conversation', () => {
    const conversation = classifyChildProcess({
      pid: 200,
      ppid: 100,
      rssKb: 1,
      cpuPercent: 0,
      command: '/Users/someone/.local/bin/claude',
      args: 'claude --output-format stream-json --verbose --input-format stream-json',
    })
    assert.deepEqual(conversation, { kind: 'agent', name: 'Claude conversation' })
    const terminal = classifyChildProcess({
      pid: 201,
      ppid: 100,
      rssKb: 1,
      cpuPercent: 0,
      command: '/Users/someone/.local/bin/claude',
      args: 'claude --resume abc',
    })
    assert.deepEqual(terminal, { kind: 'agent', name: 'Claude CLI' })
  })

  console.log('child-process-metrics tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
