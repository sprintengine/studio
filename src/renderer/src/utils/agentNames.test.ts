import assert from 'node:assert/strict'

import {
  AGENT_FIRST_NAMES,
  AGENT_SURNAMES,
  pickRandomAgentName,
} from './agentNames'

const originalRandom = Math.random

try {
  testNamePoolsStayShort()
  testPicksTwoPartNames()
  testAvoidsTakenFullNames()
  testFallsBackToNumberedNameAfterCombinationPoolIsExhausted()
} finally {
  Math.random = originalRandom
}

function withRandom(value: number, run: () => void): void {
  Math.random = () => value
  try {
    run()
  } finally {
    Math.random = originalRandom
  }
}

function testNamePoolsStayShort(): void {
  assert.ok(AGENT_FIRST_NAMES.length >= 80)
  assert.ok(AGENT_SURNAMES.length >= 80)
  assert.ok(AGENT_FIRST_NAMES.every((name) => name.length <= 5))
  assert.ok(AGENT_SURNAMES.every((name) => name.length <= 5))
}

function testPicksTwoPartNames(): void {
  withRandom(0, () => {
    const name = pickRandomAgentName()

    assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/)
    assert.equal(name, 'Abe Ames')
  })
}

function testAvoidsTakenFullNames(): void {
  withRandom(0, () => {
    assert.equal(pickRandomAgentName(['Abe Ames']), 'Ada Ames')
  })
}

function testFallsBackToNumberedNameAfterCombinationPoolIsExhausted(): void {
  const takenNames = AGENT_SURNAMES.flatMap((surname) =>
    AGENT_FIRST_NAMES.map((firstName) => `${firstName} ${surname}`)
  )

  withRandom(0, () => {
    assert.equal(pickRandomAgentName(takenNames), 'Abe Ames 2')
  })
}
