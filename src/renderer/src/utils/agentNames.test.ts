import assert from 'node:assert/strict'

import { AGENT_FIRST_NAMES, AGENT_SURNAMES, isPlaceholderAgentName, pickRandomAgentName } from './agentNames'

const originalRandom = Math.random

try {
  testNamePoolsStayShort()
  testPicksTwoPartNames()
  testAvoidsTakenFullNames()
  testFallsBackToNumberedNameAfterCombinationPoolIsExhausted()
  testPlaceholderNamesAreDetectedAndRealNamesSurvive()
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
    assert.equal(name, 'Aed Ahern')
  })
}

function testAvoidsTakenFullNames(): void {
  withRandom(0, () => {
    assert.equal(pickRandomAgentName(['Aed Ahern']), 'Aidan Ahern')
  })
}

function testPlaceholderNamesAreDetectedAndRealNamesSurvive(): void {
  // Generic layout-template tab labels are slots, not identities.
  for (const placeholder of ['Agent', 'agent', 'Agent 2', ' Agent 10 ', 'A1', 'a9']) {
    assert.ok(isPlaceholderAgentName(placeholder), `${placeholder} is a placeholder`)
  }
  // Picked names, user names, and user-saved template names all survive.
  for (const real of ['Aed Ahern', 'Reviewer', 'Agent Smith', 'Aoife', 'A Team']) {
    assert.ok(!isPlaceholderAgentName(real), `${real} is a real name`)
  }
}

function testFallsBackToNumberedNameAfterCombinationPoolIsExhausted(): void {
  const takenNames = AGENT_SURNAMES.flatMap((surname) =>
    AGENT_FIRST_NAMES.map((firstName) => `${firstName} ${surname}`),
  )

  withRandom(0, () => {
    assert.equal(pickRandomAgentName(takenNames), 'Aed Ahern 2')
  })
}
