import assert from 'node:assert/strict'
import type { Workspace } from '../types/workspace'
import {
  canSnoozeWorkspace,
  hasSnooze,
  isSnoozeUnexpired,
  isSnoozedWorkspace,
  resolveSnoozePresets,
  snoozeWakeLabel,
  snoozeWorkspacePatch,
  wakeSnoozedWorkspacePatch,
  workspaceRaisedHandWhileSnoozed,
  workspaceWokeAt,
} from './workspaceSnooze'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// A fixed instant for the pure rules. The PRESET tests build their own clocks
// from local calendar parts, because that is what the presets reason in.
const NOW = 1_000_000_000_000

function ws(fields: Partial<Workspace>): Workspace {
  return {
    id: 'w',
    name: 'w',
    mode: 'standard',
    createdAt: NOW - 10 * DAY,
    ...fields,
  } as unknown as Workspace
}

const AWAKE = { needsInput: false }
const ASKING = { needsInput: true }

// ---------------------------------------------------------------------------
// The field test
// ---------------------------------------------------------------------------

assert.equal(hasSnooze(ws({})), false, 'a fresh row carries no snooze')
assert.equal(hasSnooze(ws({ snoozedUntil: NOW })), true, 'a stamp is a snooze')
assert.equal(hasSnooze(ws({ snoozedUntil: null })), false, 'an explicit null is not a stamp')
assert.equal(hasSnooze(ws({ snoozedUntil: Number.NaN })), false, 'a NaN stamp is not a snooze')

// ---------------------------------------------------------------------------
// Asleep, awake, and the wake that nothing schedules
// ---------------------------------------------------------------------------

assert.equal(
  isSnoozedWorkspace(ws({ snoozedUntil: NOW + HOUR, snoozedAt: NOW }), NOW, AWAKE),
  true,
  'a wake time in the future is asleep'
)
assert.equal(
  isSnoozedWorkspace(ws({ snoozedUntil: NOW - 1, snoozedAt: NOW - HOUR }), NOW, AWAKE),
  false,
  'the wake needs no event: a stamp in the past simply stops reading as asleep'
)
assert.equal(
  isSnoozedWorkspace(ws({ snoozedUntil: NOW, snoozedAt: NOW - HOUR }), NOW, AWAKE),
  false,
  'the wake instant itself is awake, so a countdown never sits at zero while hidden'
)
assert.equal(isSnoozedWorkspace(ws({}), NOW, AWAKE), false, 'no stamp, never asleep')
assert.equal(
  isSnoozedWorkspace(ws({ snoozedUntil: Number.NaN }), NOW, AWAKE),
  false,
  'malformed data never hides a row'
)

// A machine asleep past the wake time has nothing to recover: the row is simply
// awake when it comes back, however long "past" was.
assert.equal(
  isSnoozedWorkspace(ws({ snoozedUntil: NOW - 90 * DAY, snoozedAt: NOW - 91 * DAY }), NOW, AWAKE),
  false,
  'a wake missed while the app was closed is not a wake owed'
)

// ---------------------------------------------------------------------------
// Raising a hand
// ---------------------------------------------------------------------------

assert.equal(
  workspaceRaisedHandWhileSnoozed(ws({ snoozedAt: NOW - HOUR }), ASKING),
  true,
  'an agent blocked on the person outranks the snooze'
)
assert.equal(
  isSnoozedWorkspace(ws({ snoozedUntil: NOW + HOUR, snoozedAt: NOW - HOUR }), NOW, ASKING),
  false,
  'and so the row is not hidden, wake time or not'
)

assert.equal(
  workspaceRaisedHandWhileSnoozed(ws({ snoozedAt: NOW - HOUR, lastTurnEndedAt: NOW - MINUTE }), AWAKE),
  true,
  'a turn that ended AFTER the snooze is news'
)
// The whole reason `snoozedAt` is stored. Without it a chat snoozed after its
// agent finished would read that same finish as news and wake instantly, every
// tick, forever.
assert.equal(
  workspaceRaisedHandWhileSnoozed(ws({ snoozedAt: NOW - MINUTE, lastTurnEndedAt: NOW - HOUR }), AWAKE),
  false,
  'a turn that ended BEFORE the snooze is what the person was dismissing'
)
assert.equal(
  workspaceRaisedHandWhileSnoozed(ws({ snoozedAt: NOW, lastTurnEndedAt: NOW }), AWAKE),
  false,
  'the same instant is not strictly after, so it does not wake'
)
assert.equal(
  workspaceRaisedHandWhileSnoozed(ws({ lastTurnEndedAt: NOW + HOUR }), AWAKE),
  false,
  'with no snoozedAt there is no line to be newer than'
)

// ---------------------------------------------------------------------------
// The plain timer test the settle sweep asks
// ---------------------------------------------------------------------------

assert.equal(
  isSnoozeUnexpired(ws({ snoozedUntil: NOW + HOUR }), NOW),
  true,
  'a running snooze holds the settle sweep off'
)
assert.equal(
  isSnoozeUnexpired(ws({ snoozedUntil: NOW + HOUR, snoozedAt: NOW - DAY, lastTurnEndedAt: NOW }), NOW),
  true,
  'and it does so even for a row whose hand is up — the sweep judges that separately'
)
assert.equal(isSnoozeUnexpired(ws({ snoozedUntil: NOW - 1 }), NOW), false, 'a spent snooze holds nothing off')

// ---------------------------------------------------------------------------
// What may be snoozed
// ---------------------------------------------------------------------------

assert.equal(canSnoozeWorkspace(ws({}), AWAKE), true, 'an ordinary row may sleep')
assert.equal(
  canSnoozeWorkspace(ws({}), ASKING),
  false,
  'a row whose agent is asking may not: hiding the question defeats it'
)
assert.equal(
  canSnoozeWorkspace(ws({ settledAt: NOW }), AWAKE),
  false,
  'a settled row is already out of the list'
)
assert.equal(
  canSnoozeWorkspace(ws({ remoteOrigin: 'peer' as never }), AWAKE),
  false,
  'a Remote-band row has no shelf to sleep in'
)
// Snooze is visibility, never lifecycle: the turn keeps running, and finishing
// it is the wake.
assert.equal(canSnoozeWorkspace(ws({ settledAt: null }), AWAKE), true, 'a cleared settle stamp does not block')

// ---------------------------------------------------------------------------
// Woke
// ---------------------------------------------------------------------------

assert.equal(workspaceWokeAt(ws({}), NOW, AWAKE), null, 'a row that never slept never woke')
assert.equal(
  workspaceWokeAt(ws({ snoozedUntil: NOW + HOUR, snoozedAt: NOW }), NOW, AWAKE),
  null,
  'a row still asleep has not woken'
)
assert.equal(
  workspaceWokeAt(ws({ snoozedUntil: NOW - MINUTE, snoozedAt: NOW - HOUR }), NOW, AWAKE),
  NOW - MINUTE,
  'a timer wake reports the wake time'
)
assert.equal(
  workspaceWokeAt(
    ws({ snoozedUntil: NOW + HOUR, snoozedAt: NOW - HOUR, lastTurnEndedAt: NOW - MINUTE }),
    NOW,
    AWAKE
  ),
  NOW - MINUTE,
  'an early wake reports what triggered it, not a wake time still in the future'
)
assert.equal(
  workspaceWokeAt(ws({ snoozedUntil: NOW + HOUR, snoozedAt: NOW - HOUR }), NOW, ASKING),
  NOW - HOUR,
  'a hand-raise with no turn end falls back to when the snooze was set'
)
// The early wake stays authoritative past the scheduled time: reporting
// `snoozedUntil` then would re-date a wake that already happened.
assert.equal(
  workspaceWokeAt(
    ws({ snoozedUntil: NOW - MINUTE, snoozedAt: NOW - 2 * HOUR, lastTurnEndedAt: NOW - HOUR }),
    NOW,
    AWAKE
  ),
  NOW - HOUR,
  'the early wake is not overwritten once the timer also elapses'
)

// ---------------------------------------------------------------------------
// The countdown
// ---------------------------------------------------------------------------

assert.equal(snoozeWakeLabel(NOW + 42 * MINUTE, NOW), '42m', 'minutes under the hour')
assert.equal(snoozeWakeLabel(NOW + 1000, NOW), '1m', 'a second still hidden rounds UP, never to "0m"')
assert.equal(snoozeWakeLabel(NOW + 90 * MINUTE, NOW), '2h', 'part-hours round up too')
assert.equal(snoozeWakeLabel(NOW + 2 * HOUR, NOW), '2h', 'a whole number of hours stays whole')
assert.equal(snoozeWakeLabel(NOW + 25 * HOUR, NOW), '2d', 'past a day, days')
assert.equal(snoozeWakeLabel(NOW - 1, NOW), 'now', 'a spent wake reads "now"')
assert.equal(snoozeWakeLabel(NOW, NOW), 'now', 'and so does the instant itself')

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

assert.deepEqual(
  snoozeWorkspacePatch(NOW + HOUR, NOW),
  { snoozedUntil: NOW + HOUR, snoozedAt: NOW },
  'a snooze writes both halves — the wake, and the line news has to beat'
)
assert.deepEqual(
  wakeSnoozedWorkspacePatch(),
  { snoozedUntil: null, snoozedAt: null },
  'a wake tombstones both, so an absent key never reads as "no opinion"'
)

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** A local-calendar instant, so the presets are tested in the terms they use. */
function localTime(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

// A Wednesday mid-morning: every preset is meaningfully ahead.
{
  const now = localTime(2026, 9, 9, 10, 15)
  const presets = resolveSnoozePresets(now)
  const ids = presets.map((preset) => preset.id)
  assert.deepEqual(
    ids,
    ['hour', 'three-hours', 'evening', 'tomorrow', 'next-week'],
    'a mid-morning weekday offers the whole ladder, nearest first'
  )
  const by = new Map(presets.map((preset) => [preset.id, preset.wakeAt]))
  assert.equal(by.get('hour'), now + HOUR, 'an hour is an hour')
  assert.equal(by.get('three-hours'), now + 3 * HOUR, 'three hours is three hours')
  assert.equal(by.get('evening'), localTime(2026, 9, 9, 18), 'this evening is 18:00 today')
  assert.equal(by.get('tomorrow'), localTime(2026, 9, 10, 9), 'tomorrow is 09:00 the next day')
  assert.equal(by.get('next-week'), localTime(2026, 9, 14, 9), 'next week is 09:00 the coming Monday')
  // Every wake time is in the future, and the list is sorted by it.
  const times = presets.map((preset) => preset.wakeAt)
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'the ladder climbs')
  assert.ok(times.every((at) => at > now), 'no preset is already in the past')
  assert.ok(
    presets.every((preset) => preset.label.length > 0 && preset.whenLabel.length > 0),
    'every row says both what it is and when it lands'
  )
}

// Late afternoon: "This evening" is minutes away and stops being offered — it
// promises the rest of the afternoon and would deliver five minutes.
{
  const presets = resolveSnoozePresets(localTime(2026, 9, 9, 17, 30))
  assert.ok(!presets.some((preset) => preset.id === 'evening'), 'no evening once evening is within the hour')
  assert.ok(presets.some((preset) => preset.id === 'tomorrow'), 'the calendar choices carry on')
}
{
  const presets = resolveSnoozePresets(localTime(2026, 9, 9, 16, 30))
  assert.ok(presets.some((preset) => preset.id === 'evening'), 'still offered while it is more than an hour off')
}
{
  const presets = resolveSnoozePresets(localTime(2026, 9, 9, 21, 0))
  assert.ok(!presets.some((preset) => preset.id === 'evening'), 'and never once evening has passed')
}

// Sunday: "Tomorrow" and "Next week" are the same Monday morning, so only one
// row is offered. Two rows onto one instant is a menu lying about a choice.
{
  const presets = resolveSnoozePresets(localTime(2026, 9, 13, 10, 0))
  assert.equal(new Date(localTime(2026, 9, 13, 10, 0)).getDay(), 0, 'the fixture really is a Sunday')
  assert.ok(presets.some((preset) => preset.id === 'tomorrow'), 'Tomorrow survives')
  assert.ok(!presets.some((preset) => preset.id === 'next-week'), 'Next week collapses into it')
  const wakes = presets.map((preset) => preset.wakeAt)
  assert.equal(new Set(wakes).size, wakes.length, 'no two rows share a wake time')
}

// Monday means the NEXT Monday, not today.
{
  const monday = localTime(2026, 9, 14, 10, 0)
  assert.equal(new Date(monday).getDay(), 1, 'the fixture really is a Monday')
  const nextWeek = resolveSnoozePresets(monday).find((preset) => preset.id === 'next-week')
  assert.equal(nextWeek?.wakeAt, localTime(2026, 9, 21, 9), 'a week out, not this morning')
}

// Calendar arithmetic, not `+ 86_400_000`. Across a spring-forward boundary a
// day is 23 hours, so a fixed offset from late evening skips the next day
// entirely. Only asserted where the test machine's zone actually shifts.
{
  const beforeSpringForward = localTime(2026, 3, 7, 23, 30)
  const tomorrow = resolveSnoozePresets(beforeSpringForward).find((preset) => preset.id === 'tomorrow')
  const landed = new Date(tomorrow!.wakeAt)
  assert.equal(landed.getDate(), 8, 'Tomorrow lands on the next calendar day')
  assert.equal(landed.getHours(), 9, 'at the morning hour, whatever the offset did')
}

console.log('ok - workspaceSnooze')
