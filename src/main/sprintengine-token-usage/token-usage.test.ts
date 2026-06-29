import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readSessionTokenUsage } from './index'
import type { FetchLike, ModelTokenUsage } from './types'

const FIXTURES = path.join(process.cwd(), 'src/main/sprintengine-token-usage/__fixtures__')
const CLAUDE_SID = '7b4eb104-03f5-4759-994c-5d9570a5bb79'
const CODEX_SID = '019ee51e-a80a-7231-bd19-035a80374654'
const NOW = '2026-06-28T00:00:00.000Z'

async function run(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function modelOf(perModel: ModelTokenUsage[], model: string): ModelTokenUsage {
  const found = perModel.find((m) => m.model === model)
  assert.ok(found, `expected usage for model ${model}`)
  return found
}

// Build a Claude Code home: <home>/.claude/projects/<enc>/<sid>.jsonl plus the
// sibling <sid>/subagents/agent-*.jsonl, mirroring the real on-disk layout.
async function buildClaudeHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-home-'))
  const projectDir = path.join(home, '.claude', 'projects', '-Users-dev-proj')
  await mkdir(path.join(projectDir, CLAUDE_SID, 'subagents'), { recursive: true })
  await copyFile(
    path.join(FIXTURES, 'claude-code-main.jsonl'),
    path.join(projectDir, `${CLAUDE_SID}.jsonl`),
  )
  await copyFile(
    path.join(FIXTURES, 'claude-code-subagent.jsonl'),
    path.join(projectDir, CLAUDE_SID, 'subagents', 'agent-abc.jsonl'),
  )
  return home
}

async function buildCodexHome(root: string): Promise<void> {
  const dayDir = path.join(root, 'sessions', '2026', '06', '20')
  await mkdir(dayDir, { recursive: true })
  await copyFile(
    path.join(FIXTURES, 'codex-rollout.jsonl'),
    path.join(dayDir, `rollout-2026-06-20T14-00-52-${CODEX_SID}.jsonl`),
  )
}

async function main(): Promise<void> {
  await run('claude-code: sums main + subagent usage grouped by model', async () => {
    const home = await buildClaudeHome()
    const usage = await readSessionTokenUsage('claude-code', CLAUDE_SID, {
      homeDir: home,
      env: {},
      now: () => NOW,
    })
    assert.equal(usage.measured, true)
    assert.equal(usage.cli, 'claude-code')
    assert.equal(usage.cliSessionId, CLAUDE_SID)
    assert.equal(usage.sampledAt, NOW)
    assert.equal(usage.perModel.length, 2, 'opus + sonnet')

    // opus = main(a1+a2, a2 duplicate-uuid counted once) + subagent(sa1+sa2)
    const opus = modelOf(usage.perModel, 'claude-opus-4-8')
    assert.equal(opus.input, 1807 + 12 + 900 + 40)
    assert.equal(opus.output, 188 + 340 + 120 + 60)
    assert.equal(opus.cacheRead, 8605 + 20000 + 3000 + 3100)
    assert.equal(opus.cacheCreation, 4152 + 0 + 50 + 0)

    const sonnet = modelOf(usage.perModel, 'claude-sonnet-4-6')
    assert.deepEqual(
      { input: sonnet.input, output: sonnet.output, cacheRead: sonnet.cacheRead, cacheCreation: sonnet.cacheCreation },
      { input: 500, output: 75, cacheRead: 1000, cacheCreation: 200 },
    )
  })

  await run('claude-code: respects CLAUDE_CONFIG_DIR override', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'claude-cfg-'))
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'claude-altcfg-'))
    const projectDir = path.join(configDir, 'projects', '-Users-dev-proj')
    await mkdir(projectDir, { recursive: true })
    await copyFile(
      path.join(FIXTURES, 'claude-code-main.jsonl'),
      path.join(projectDir, `${CLAUDE_SID}.jsonl`),
    )
    const usage = await readSessionTokenUsage('claude-code', CLAUDE_SID, {
      homeDir: home, // has no .claude — only the override holds the transcript
      env: { CLAUDE_CONFIG_DIR: configDir },
      now: () => NOW,
    })
    assert.equal(usage.measured, true)
    assert.equal(modelOf(usage.perModel, 'claude-opus-4-8').output, 188 + 340)
  })

  await run('codex: reads last cumulative token_count, not the sum of events', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-home-'))
    await buildCodexHome(codexHome)
    const usage = await readSessionTokenUsage('codex', CODEX_SID, {
      homeDir: await mkdtemp(path.join(os.tmpdir(), 'empty-home-')),
      env: { CODEX_HOME: codexHome }, // env override respected
      now: () => NOW,
    })
    assert.equal(usage.measured, true)
    assert.equal(usage.perModel.length, 1)
    const m = usage.perModel[0]
    assert.equal(m.model, 'gpt-5.5')
    assert.equal(m.input, 7789460) // last event, not 100000 + 7789460
    assert.equal(m.output, 25709)
    assert.equal(m.cacheRead, 7209984) // cached_input_tokens -> cacheRead
    assert.equal(m.cacheCreation, 0)
  })

  await run('missing source returns measured:false with a timestamp, never throws', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'empty-'))
    for (const cli of ['claude-code', 'codex']) {
      const usage = await readSessionTokenUsage(cli, 'does-not-exist', {
        homeDir: home,
        env: {},
        now: () => NOW,
      })
      assert.equal(usage.measured, false, `${cli} unmeasured`)
      assert.deepEqual(usage.perModel, [])
      assert.equal(usage.sampledAt, NOW)
    }
  })

  await run('unsupported cli and empty session id are unmeasured', async () => {
    const unknown = await readSessionTokenUsage('some-future-cli', 'sid', { now: () => NOW })
    assert.equal(unknown.measured, false)

    const empty = await readSessionTokenUsage('claude-code', '', { now: () => NOW })
    assert.equal(empty.measured, false)
    assert.equal(empty.sampledAt, NOW)
  })

  await run('opencode: sums assistant tokens per model with reasoning folded into output', async () => {
    const messages = JSON.parse(await readFile(path.join(FIXTURES, 'opencode-messages.json'), 'utf8'))
    const calls: Array<{ url: string; auth?: string }> = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, auth: init?.headers?.Authorization })
      return { ok: true, status: 200, json: async () => messages }
    }
    const usage = await readSessionTokenUsage('opencode', 'ses_abc', {
      env: { OPENCODE_SERVER: 'http://127.0.0.1:7000/' },
      fetchImpl,
      now: () => NOW,
    })
    assert.equal(usage.measured, true)
    assert.equal(usage.perModel.length, 2, 'big-pickle + claude-sonnet-4-6')

    // null-tokens assistant row skipped; reasoning folded into output; cache.read
    // -> cacheRead, cache.write -> cacheCreation.
    const big = modelOf(usage.perModel, 'big-pickle')
    assert.equal(big.input, 7882 + 100)
    assert.equal(big.output, (3 + 11) + (20 + 5))
    assert.equal(big.cacheRead, 0 + 50)
    assert.equal(big.cacheCreation, 0 + 10)

    const sonnet = modelOf(usage.perModel, 'claude-sonnet-4-6')
    assert.deepEqual(
      { input: sonnet.input, output: sonnet.output, cacheRead: sonnet.cacheRead, cacheCreation: sonnet.cacheCreation },
      { input: 500, output: 75, cacheRead: 1000, cacheCreation: 200 },
    )

    // URL built from base (trailing slash stripped) + session id; no auth without a password.
    assert.equal(calls[0]?.url, 'http://127.0.0.1:7000/session/ses_abc/message')
    assert.equal(calls[0]?.auth, undefined)
  })

  await run('opencode: sends HTTP basic auth when OPENCODE_SERVER_PASSWORD is set', async () => {
    let authHeader: string | undefined
    const fetchImpl: FetchLike = async (_url, init) => {
      authHeader = init?.headers?.Authorization
      return { ok: true, status: 200, json: async () => [] }
    }
    const usage = await readSessionTokenUsage('opencode', 'ses_abc', {
      env: { OPENCODE_SERVER: 'http://127.0.0.1:7000', OPENCODE_SERVER_PASSWORD: 'secret123' },
      fetchImpl,
      now: () => NOW,
    })
    // A reachable server with an existing-but-empty session is a real zero reading.
    assert.equal(usage.measured, true)
    assert.deepEqual(usage.perModel, [])
    assert.equal(authHeader, `Basic ${Buffer.from('opencode:secret123').toString('base64')}`)
  })

  await run('opencode: unreachable server and 404 session are unmeasured, never throw', async () => {
    const throwing: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    const unreachable = await readSessionTokenUsage('opencode', 'ses_abc', {
      env: { OPENCODE_SERVER: 'http://127.0.0.1:7000' },
      fetchImpl: throwing,
      now: () => NOW,
    })
    assert.equal(unreachable.measured, false)
    assert.deepEqual(unreachable.perModel, [])

    const notFound: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}) })
    const missing = await readSessionTokenUsage('opencode', 'ses_missing', {
      env: { OPENCODE_SERVER: 'http://127.0.0.1:7000' },
      fetchImpl: notFound,
      now: () => NOW,
    })
    assert.equal(missing.measured, false)
  })

  await run('claude-code: a path-traversal-shaped session id is rejected unmeasured, never throws', async () => {
    // A real transcript home exists; the malformed id must be rejected on charset
    // before any path.join, so it cannot resolve a sibling file via `..` segments.
    const home = await buildClaudeHome()
    for (const id of ['../../../../etc/passwd', `${CLAUDE_SID}/../other`, 'a/b']) {
      const usage = await readSessionTokenUsage('claude-code', id, {
        homeDir: home,
        env: {},
        now: () => NOW,
      })
      assert.equal(usage.measured, false, `${id} -> unmeasured`)
      assert.deepEqual(usage.perModel, [])
      assert.equal(usage.sampledAt, NOW)
    }
  })

  await run('opencode: a non-loopback OPENCODE_SERVER is unmeasured and never calls fetch', async () => {
    let called = false
    const fetchImpl: FetchLike = async () => {
      called = true
      return { ok: true, status: 200, json: async () => [] }
    }
    for (const server of ['http://evil.example.com:7000', 'http://10.0.0.5:7000', 'not a url']) {
      const usage = await readSessionTokenUsage('opencode', 'ses_abc', {
        env: { OPENCODE_SERVER: server, OPENCODE_SERVER_PASSWORD: 'secret123' },
        fetchImpl,
        now: () => NOW,
      })
      assert.equal(usage.measured, false, `${server} -> unmeasured`)
      assert.deepEqual(usage.perModel, [])
    }
    assert.equal(called, false, 'non-loopback base url -> credentials never sent')
  })

  await run('opencode: the credentialed request is sent with redirect:error', async () => {
    let redirect: string | undefined
    const fetchImpl: FetchLike = async (_url, init) => {
      redirect = init?.redirect
      return { ok: true, status: 200, json: async () => [] }
    }
    const usage = await readSessionTokenUsage('opencode', 'ses_abc', {
      env: { OPENCODE_SERVER: 'http://127.0.0.1:7000', OPENCODE_SERVER_PASSWORD: 'secret123' },
      fetchImpl,
      now: () => NOW,
    })
    assert.equal(usage.measured, true)
    assert.equal(redirect, 'error', 'a 3xx cannot move the Basic-auth request off-origin')
  })

  await run('opencode: no OPENCODE_SERVER configured is unmeasured and never calls fetch', async () => {
    let called = false
    const fetchImpl: FetchLike = async () => {
      called = true
      return { ok: true, status: 200, json: async () => [] }
    }
    const usage = await readSessionTokenUsage('opencode', 'ses_abc', { env: {}, fetchImpl, now: () => NOW })
    assert.equal(usage.measured, false)
    assert.equal(called, false, 'no base url -> no HTTP call')
  })

  console.log('sprintengine token-usage tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
