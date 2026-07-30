import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readSessionTokenUsage } from './index'
import type { FetchLike, ModelTokenUsage } from './types'

const FIXTURES = path.join(process.cwd(), 'src/main/sprintengine-token-usage/__fixtures__')
const CLAUDE_SID = '7b4eb104-03f5-4759-994c-5d9570a5bb79'
const CODEX_SID = '019ee51e-a80a-7231-bd19-035a80374654'
const GROK_SID = '9a1b2c3d-e4f5-4a6b-8c7d-0e1f2a3b4c5d'
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

// Grok Build layout: <GROK_HOME>/sessions/<urlencoded-workspace>/<sid>/updates.jsonl
// with the sibling signals.json rollup.
async function buildGrokHome(root: string, withSignals: boolean): Promise<void> {
  const sessionDir = path.join(root, 'sessions', '%2FUsers%2Fdev%2Fproj', GROK_SID)
  await mkdir(sessionDir, { recursive: true })
  await copyFile(path.join(FIXTURES, 'grok-updates.jsonl'), path.join(sessionDir, 'updates.jsonl'))
  if (withSignals) {
    await copyFile(path.join(FIXTURES, 'grok-signals.json'), path.join(sessionDir, 'signals.json'))
  }
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

    // sonnet is a 3-row multi-block turn (distinct uuids a5/a6/a7, same
    // message.id, identical usage — how real Claude Code writes tool-use
    // turns): counted ONCE via the message-id dedup, never per row.
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

  await run('codex: reads last cumulative token_count, normalizing cached input out of input', async () => {
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
    // Last event (not 100000 + 7789460), with Codex's cache-inclusive input
    // normalized so `input` means non-cached input like every other CLI.
    assert.equal(m.input, 7789460 - 7209984)
    assert.equal(m.output, 25709)
    assert.equal(m.cacheRead, 7209984) // cached_input_tokens -> cacheRead
    assert.equal(m.cacheCreation, 0)
    assert.equal(m.split, true)
    // Codex's own total_tokens (7815169) LESS the cached re-reads it folds in:
    // cache reads sit outside `total` for every CLI, so the headline stays
    // "each token once" rather than the same context re-counted per turn.
    assert.equal(m.total, 7815169 - 7209984)
  })

  await run('grok: total-only reading reconciled against the signals.json rollup', async () => {
    const grokHome = await mkdtemp(path.join(os.tmpdir(), 'grok-home-'))
    await buildGrokHome(grokHome, true)
    const usage = await readSessionTokenUsage('grok', GROK_SID, {
      homeDir: await mkdtemp(path.join(os.tmpdir(), 'empty-home-')),
      env: { GROK_HOME: grokHome }, // env override respected
      now: () => NOW,
    })
    assert.equal(usage.measured, true)
    assert.equal(usage.perModel.length, 1)
    const m = usage.perModel[0]
    assert.equal(m.model, 'grok-4.5')
    // signals: totalTokensBeforeCompaction + contextTokensUsed beats both the
    // rollup's own totalTokens and the updates stream's monotonic max.
    assert.equal(m.total, 3224659 + 172309)
    // Total-only: no fabricated input/output split.
    assert.equal(m.split, false)
    assert.deepEqual(
      { input: m.input, output: m.output, cacheRead: m.cacheRead, cacheCreation: m.cacheCreation },
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    )
  })

  await run('grok: without signals.json the monotonic max of the updates counter wins', async () => {
    const grokHome = await mkdtemp(path.join(os.tmpdir(), 'grok-home-'))
    await buildGrokHome(grokHome, false)
    const usage = await readSessionTokenUsage('grok', GROK_SID, {
      homeDir: await mkdtemp(path.join(os.tmpdir(), 'empty-home-')),
      env: { GROK_HOME: grokHome },
      now: () => NOW,
    })
    assert.equal(usage.measured, true)
    // 171056 is the max; the later rewound 120000 reading is ignored.
    assert.equal(usage.perModel[0]?.total, 171056)
    assert.equal(usage.perModel[0]?.model, 'grok-4.5')
  })

  await run('zai routes to the Claude Code adapter (same harness, same transcripts)', async () => {
    const home = await buildClaudeHome()
    const usage = await readSessionTokenUsage('zai', CLAUDE_SID, {
      homeDir: home,
      env: {},
      now: () => NOW,
    })
    assert.equal(usage.measured, true)
    assert.equal(usage.cli, 'zai') // coverage names the real CLI, not the adapter family
    assert.equal(modelOf(usage.perModel, 'claude-opus-4-8').output, 188 + 340 + 120 + 60)
  })

  await run('grok + codex: a located session with no usage yet is a REAL zero, measured', async () => {
    // Grok: workspace/session dir exists, updates.jsonl parseable, but no
    // totalTokens counter anywhere — a session that has not run a turn.
    const zeroSid = 'f0e1d2c3-0000-4000-8000-000000000001'
    const grokHome = await mkdtemp(path.join(os.tmpdir(), 'grok-zero-'))
    const grokDir = path.join(grokHome, 'sessions', '%2FUsers%2Fdev%2Fproj', zeroSid)
    await mkdir(grokDir, { recursive: true })
    await writeFile(
      path.join(grokDir, 'updates.jsonl'),
      '{"method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"available_commands_update"}}}\n',
      'utf8',
    )
    const grokUsage = await readSessionTokenUsage('grok', zeroSid, {
      homeDir: await mkdtemp(path.join(os.tmpdir(), 'empty-home-')),
      env: { GROK_HOME: grokHome },
      now: () => NOW,
    })
    assert.equal(grokUsage.measured, true, 'grok zero session is measured')
    assert.deepEqual(grokUsage.perModel, [])

    // Codex: rollout exists but carries only a session_meta and an info-less
    // token_count (a rate-limit ping) — same contract, measured zero.
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-zero-'))
    const dayDir = path.join(codexHome, 'sessions', '2026', '07', '09')
    await mkdir(dayDir, { recursive: true })
    await writeFile(
      path.join(dayDir, `rollout-2026-07-09T00-00-00-${zeroSid}.jsonl`),
      '{"type":"session_meta","payload":{"id":"x"}}\n{"type":"event_msg","payload":{"type":"token_count","info":null}}\n',
      'utf8',
    )
    const codexUsage = await readSessionTokenUsage('codex', zeroSid, {
      homeDir: await mkdtemp(path.join(os.tmpdir(), 'empty-home-')),
      env: { CODEX_HOME: codexHome },
      now: () => NOW,
    })
    assert.equal(codexUsage.measured, true, 'codex zero session is measured')
    assert.deepEqual(codexUsage.perModel, [])
  })

  await run('a manifest-declared claude-harness CLI routes to the claude adapter', async () => {
    const home = await buildClaudeHome()
    const usage = await readSessionTokenUsage('openrouter-claude', CLAUDE_SID, {
      homeDir: home,
      env: {},
      now: () => NOW,
      isClaudeHarnessCli: (cli) => cli === 'openrouter-claude',
    })
    assert.equal(usage.measured, true)
    assert.equal(modelOf(usage.perModel, 'claude-opus-4-8').input, 1807 + 12 + 900 + 40)

    // Without the probe the unknown CLI stays unmeasured (never guessed).
    const unrouted = await readSessionTokenUsage('openrouter-claude', CLAUDE_SID, {
      homeDir: home,
      env: {},
      now: () => NOW,
    })
    assert.equal(unrouted.measured, false)
  })

  await run('claude-code: split rows total each token once, cache reads excluded', async () => {
    const home = await buildClaudeHome()
    const usage = await readSessionTokenUsage('claude-code', CLAUDE_SID, {
      homeDir: home,
      env: {},
      now: () => NOW,
    })
    const opus = modelOf(usage.perModel, 'claude-opus-4-8')
    assert.equal(opus.split, true)
    assert.equal(opus.total, opus.input + opus.output + opus.cacheCreation)
    // The read figure is still carried, just not folded into the total — every
    // turn re-reads the whole context, so adding it counts the same tokens once
    // per turn (the defect that showed a 9M-token sprint as 738M).
    assert.ok(opus.cacheRead > 0, 'cache reads are still reported')
    assert.ok(opus.total < opus.cacheRead, 'the total does not swallow the reads')
  })

  await run('missing source returns measured:false with a timestamp, never throws', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'empty-'))
    for (const cli of ['claude-code', 'codex', 'grok']) {
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
