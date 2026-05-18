import assert from 'node:assert/strict'

import { createAgentStreamWatcher } from './agent-stream-watcher'

async function main(): Promise<void> {
  testReadinessPatternFiresOncePerWatcher()
  testCompletionSentinelDetectedAcrossChunks()
  testNoReadinessWhenNoPattern()
  testEmptyChunkIsNoOp()
  testRollingBufferDropsOldContent()
  testReadinessAndCompletionInSameChunk()
  testResetClearsState()

  console.log('agent-stream-watcher tests passed')
}

function testReadinessPatternFiresOncePerWatcher(): void {
  const watcher = createAgentStreamWatcher({
    readinessPattern: /^>\s/m,
  })
  const first = watcher.ingest('Welcome to Claude Code\n')
  assert.equal(first.readyMatched, false)

  const second = watcher.ingest('> ')
  assert.equal(second.readyMatched, true)

  const third = watcher.ingest('> ')
  assert.equal(third.readyMatched, false, 'readiness should fire at most once until reset')
}

function testCompletionSentinelDetectedAcrossChunks(): void {
  const watcher = createAgentStreamWatcher({
    completionSentinel: '[sprint-engine:done]',
  })
  let result = watcher.ingest('Doing work...\n[sprint-')
  assert.equal(result.completionMatched, false)

  result = watcher.ingest('engine:done]\nFinishing up.')
  assert.equal(result.completionMatched, true)

  result = watcher.ingest('[sprint-engine:done]')
  assert.equal(result.completionMatched, false, 'sentinel should fire at most once until reset')
}

function testNoReadinessWhenNoPattern(): void {
  const watcher = createAgentStreamWatcher({
    completionSentinel: 'done',
  })
  const result = watcher.ingest('> any output ')
  assert.equal(result.readyMatched, false)
  assert.equal(result.completionMatched, false)
}

function testEmptyChunkIsNoOp(): void {
  const watcher = createAgentStreamWatcher({
    readinessPattern: /ready/,
    completionSentinel: 'done',
  })
  const result = watcher.ingest('')
  assert.equal(result.readyMatched, false)
  assert.equal(result.completionMatched, false)
}

function testRollingBufferDropsOldContent(): void {
  const watcher = createAgentStreamWatcher({
    completionSentinel: 'XYZ-done-XYZ',
    rollingBufferSize: 128,
  })
  // Flood the buffer past its size with content that does NOT contain the
  // sentinel. Then write the sentinel — the sentinel must still fire even
  // though the early data has been evicted.
  for (let i = 0; i < 10; i++) {
    watcher.ingest('A'.repeat(50))
  }
  const result = watcher.ingest('XYZ-done-XYZ')
  assert.equal(result.completionMatched, true)
}

function testReadinessAndCompletionInSameChunk(): void {
  const watcher = createAgentStreamWatcher({
    readinessPattern: /^>\s/m,
    completionSentinel: '[done]',
  })
  const result = watcher.ingest('> [done]')
  assert.equal(result.readyMatched, true)
  assert.equal(result.completionMatched, true)
}

function testResetClearsState(): void {
  const watcher = createAgentStreamWatcher({
    readinessPattern: /ready/,
    completionSentinel: 'done',
  })
  watcher.ingest('ready done')
  watcher.reset()
  const result = watcher.ingest('ready done')
  assert.equal(result.readyMatched, true, 'reset should re-arm readiness')
  assert.equal(result.completionMatched, true, 'reset should re-arm completion')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
