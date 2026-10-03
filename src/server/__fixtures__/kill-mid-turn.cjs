// Run by studio-server.smoke.test.ts under plain Node, twice on one data
// directory. `start` begins a chat on the mock provider, leaves a turn waiting
// on an approval, says so on stdout and waits to be killed. `resume` starts a
// server on the same directory after that kill and reports what it finds: the
// lock it took, the gateway it bound, and the transcript of the killed turn.
//
// Usage: node kill-mid-turn.cjs <bundle> <start|resume> <dataDir> <repository> <appRoot>

'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const [bundle, mode, dataDir, repository, appRoot] = process.argv.slice(2)
const { startStudioServer } = require(bundle)

function ok(result, what) {
  if (!result || result.ok === false) throw new Error(`${what}: ${result ? result.message : 'no result'}`)
  return result
}

async function main() {
  const server = await startStudioServer({
    dataDir,
    logsDir: join(dataDir, 'logs'),
    version: 'smoke',
    packaged: false,
    appRoot,
  })
  const { core } = server
  const conversations = core.conversations
  if (mode === 'start') {
    const created = ok(
      core.workspaceSyncService.createWorkspace({ name: 'killed', folderPath: repository }, 'system'),
      'workspace',
    )
    const key = { workspaceRoot: repository, workspaceId: created.result.workspace.id, agentId: 'agent-killed' }
    writeFileSync(join(dataDir, 'key.json'), JSON.stringify(key))
    const started = ok(
      await conversations.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' }),
      'start',
    )
    const sessionId = started.session.sessionId
    const waiting = new Promise((resolve) => {
      const stop = conversations.onEvent((event) => {
        if (event.sessionId === sessionId && event.type === 'approval_requested') {
          stop()
          resolve()
        }
      })
    })
    ok(await conversations.sendTurn({ sessionId, message: 'hello' }), 'send')
    await waiting
    // The transcript is written as the turn streams; flushed so the kill
    // below finds on disk what a crash a moment later would.
    await core.conversationOwner.flushTranscripts()
    process.stdout.write(`${JSON.stringify({ waiting: true, pid: process.pid })}\n`)
    await new Promise(() => undefined)
    return
  }
  const key = JSON.parse(readFileSync(join(dataDir, 'key.json'), 'utf8'))
  const transcript = ok(await conversations.readTranscript(key), 'transcript')
  const ends = transcript.events.filter((event) => event.type === 'turn_completed' || event.type === 'turn_failed')
  process.stdout.write(
    `${JSON.stringify({
      ready: server.ready,
      lock: JSON.parse(readFileSync(join(dataDir, 'run', 'studio.lock'), 'utf8')),
      messages: transcript.events.filter((event) => event.type === 'user_message').length,
      ends: ends.map((event) => ({ type: event.type, reason: event.payload.reason ?? null })),
    })}\n`,
  )
  await server.stop()
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`)
  process.exit(1)
})
