import assert from 'node:assert/strict'

// The Extensions home's count lines (Extensions drawer ruling, 2026-09-05,
// Stage 3). Pure, so every state a real machine reaches — a fresh profile, a
// scan still running, a source that failed, version checking switched off — is
// asserted without mounting the page or standing up its five readers.
//
// Two rules run through all of it, and they are the reason these are functions
// rather than template strings at the call site: a count nobody has measured is
// ABSENT, and a count that really is nothing is WORDS.
import {
  agentCliCountLine,
  designLibraryCountLine,
  EXTENSIONS_HOME_TILE_SUMMARIES,
  mcpServerCountLine,
  skillsCountLine,
  sprintRunCountLine,
} from './extensionsHomeTiles'

// ── Nothing measured, nothing said ───────────────────────────────────────────
// The line is absent, NOT zero. A tile that reads "None installed" while its
// probe is still running states a fact the app does not have, and the person
// acts on it — the whole point of the ruling's "live count" is that it is live.
assert.equal(sprintRunCountLine({ ready: false, total: 9, running: 4 }), null)
assert.equal(designLibraryCountLine({ ready: false, count: 3 }), null)
assert.equal(skillsCountLine({ ready: false, sourceCount: 3, skillCount: 41 }), null)
assert.equal(agentCliCountLine({ ready: false, installed: 3, updates: 2 }), null)

// ── A real zero is a word ────────────────────────────────────────────────────
// What a fresh profile sees. "0 running" reads as a counter that has not
// started; these read as answers.
assert.equal(sprintRunCountLine({ ready: true, total: 0, running: 0 }), 'No runs')
assert.equal(designLibraryCountLine({ ready: true, count: 0 }), 'None in the library')
assert.equal(mcpServerCountLine(0), 'None on this machine')
assert.equal(skillsCountLine({ ready: true, sourceCount: 0, skillCount: 0 }), 'No sources')
assert.equal(agentCliCountLine({ ready: true, installed: 0, updates: 0 }), 'None installed')
for (const line of [
  sprintRunCountLine({ ready: true, total: 0, running: 0 }),
  designLibraryCountLine({ ready: true, count: 0 }),
  mcpServerCountLine(0),
  skillsCountLine({ ready: true, sourceCount: 0, skillCount: 0 }),
  agentCliCountLine({ ready: true, installed: 0, updates: 0 }),
]) {
  assert.ok(line && !line.includes('0'), `a zero count is words, not a digit: ${line}`)
}

// ── "Nothing running" is not "nothing ever ran" ──────────────────────────────
// Two different answers to two different questions, which is why the sprint
// line takes a total as well as a running count.
assert.equal(sprintRunCountLine({ ready: true, total: 6, running: 0 }), 'None running')
assert.equal(sprintRunCountLine({ ready: true, total: 6, running: 2 }), '2 running')
assert.equal(sprintRunCountLine({ ready: true, total: 1, running: 1 }), '1 running')

// ── The populated lines ──────────────────────────────────────────────────────
assert.equal(designLibraryCountLine({ ready: true, count: 1 }), '1 in the library')
assert.equal(mcpServerCountLine(3), '3 on this machine')
assert.equal(skillsCountLine({ ready: true, sourceCount: 3, skillCount: 41 }), '41 skills')
assert.equal(skillsCountLine({ ready: true, sourceCount: 1, skillCount: 1 }), '1 skill')
// A source with nothing in it is still a source: the tile says the skills are
// missing rather than the sources.
assert.equal(skillsCountLine({ ready: true, sourceCount: 2, skillCount: 0 }), 'No skills')

// ── Updates are news, and news is only reported when there is some ───────────
// "· 0 updates" is a reassurance nobody asked for on a line that exists to
// carry news; and with version checking switched off the advisory map is empty,
// which reaches here as `updates: 0` — the app has not looked, so it must not
// say "none".
assert.equal(agentCliCountLine({ ready: true, installed: 3, updates: 0 }), '3 installed')
assert.equal(agentCliCountLine({ ready: true, installed: 3, updates: 2 }), '3 installed · 2 updates')
assert.equal(agentCliCountLine({ ready: true, installed: 3, updates: 1 }), '3 installed · 1 update')

// ── Every tile the ruling named has its sentence ─────────────────────────────
// The ids are the drawer rows' own ids (a view's where the row is a view), so
// this list drifting from the drawer is a missing summary rather than a wrong
// one landing on the wrong tile.
assert.deepEqual(
  Object.keys(EXTENSIONS_HOME_TILE_SUMMARIES),
  ['sprints', 'design', 'plugins', 'skills', 'agent-clis'],
  'the ruling’s five parts, in the ruling’s order',
)
for (const [id, summary] of Object.entries(EXTENSIONS_HOME_TILE_SUMMARIES)) {
  assert.ok(summary.length > 0 && !summary.endsWith('.'), `${id}: one line, not a sentence`)
}

console.log('extensionsHomeTiles.test.ts: ok')
