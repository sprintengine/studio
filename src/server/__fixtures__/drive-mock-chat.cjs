// Run by studio-server.smoke.test.ts under plain Node: requires the built
// server bundle as a library, starts a server on a fresh data directory, and
// drives one chat on the built-in mock provider through the core's backend, in
// a git repository:
//
//   1. a turn that runs tools, during which the "agent" edits a file, and the
//      checkpoint that turn leaves, reverted;
//   2. a turn that waits on an approval, answered.
//
// Prints one JSON line of what it saw; the test asserts on that.
//
// Usage: node drive-mock-chat.cjs <bundle> <dataDir> <repository> <appRoot>

'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const [bundle, dataDir, repository, appRoot] = process.argv.slice(2)
const { startStudioServer } = require(bundle)

function waitFor(conversations, sessionId, type) {
  return new Promise((resolve) => {
    const stop = conversations.onEvent((event) => {
      if (event.sessionId === sessionId && event.type === type) {
        stop()
        resolve(event)
      }
    })
  })
}

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
  const report = { electron: Boolean(process.versions.electron), ready: server.ready }
  try {
    const { core } = server
    const conversations = core.conversations

    const created = ok(
      core.workspaceSyncService.createWorkspace({ name: 'smoke', folderPath: repository }, 'system'),
      'workspace',
    )
    const workspaceId = created.result.workspace.id
    report.workspaceListed = core.workspaceRegistry.getRecords().some((record) => record.id === workspaceId)

    const key = { workspaceRoot: repository, workspaceId, agentId: 'agent-smoke' }
    const started = ok(
      await conversations.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' }),
      'start',
    )
    const sessionId = started.session.sessionId

    // 1. Tools, and an edit while they run. The runtime takes its checkpoint
    // before the first tool that can write and hands the event on after, so
    // the edit lands between the two captures, as an agent's would.
    let edited = false
    const stopEditing = conversations.onEvent((event) => {
      if (edited || event.sessionId !== sessionId || event.type !== 'tool_started') return
      edited = true
      writeFileSync(join(repository, 'existing.txt'), 'changed by the agent\n')
    })
    const toolsDone = waitFor(conversations, sessionId, 'turn_completed')
    ok(await conversations.sendTurn({ sessionId, message: '/tools' }), 'send /tools')
    const toolsTurn = await toolsDone
    stopEditing()
    report.checkpoint = toolsTurn.payload.checkpointSummary ?? null
    const turnSeq = Number(toolsTurn.payload.checkpointTurnSeq)
    const preview = ok(await conversations.revertToTurn({ key, turnSeq }), 'revert preview')
    ok(
      await conversations.revertToTurn({
        key,
        turnSeq,
        confirmed: true,
        files: preview.files.map((file) => file.path),
      }),
      'revert',
    )
    report.revertedFiles = preview.files.map((file) => file.path)
    report.fileAfterRevert = readFileSync(join(repository, 'existing.txt'), 'utf8')

    // 2. A turn that waits on the person.
    const approval = waitFor(conversations, sessionId, 'approval_requested')
    ok(await conversations.sendTurn({ sessionId, message: 'hello' }), 'send')
    const requested = await approval
    const answeredDone = waitFor(conversations, sessionId, 'turn_completed')
    ok(
      await conversations.respondToRequest({
        sessionId,
        requestId: String(requested.payload.requestId),
        approved: true,
      }),
      'respond',
    )
    await answeredDone

    const transcript = ok(await conversations.readTranscript(key), 'transcript')
    report.replies = transcript.events
      .filter((event) => event.type === 'content_delta')
      .map((event) => event.payload.text)
    report.turnsCompleted = transcript.events.filter((event) => event.type === 'turn_completed').length
    ok(await conversations.stopSession({ sessionId }), 'stop')
  } finally {
    await server.stop()
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`)
  process.exit(1)
})
