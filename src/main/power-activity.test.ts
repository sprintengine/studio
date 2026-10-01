import assert from 'node:assert/strict'
import { test } from 'vitest'

import { bindPollerToActivity, createPowerActivity, gateStallMonitorOnActivity } from './power-activity'

function fakeMonitor() {
  const calls: string[] = []
  let running = false
  return {
    calls,
    running: () => running,
    start() {
      if (running) return
      running = true
      calls.push('start')
    },
    stop() {
      if (!running) return
      running = false
      calls.push('stop')
    },
    reset() {
      calls.push('reset')
    },
  }
}

test('the stall heartbeat runs only while a window has focus', () => {
  const activity = createPowerActivity()
  const monitor = fakeMonitor()
  const dispose = gateStallMonitorOnActivity(activity, monitor)
  assert.equal(monitor.running(), false, 'no window focused at boot: no heartbeat')

  activity.noteFocus(true)
  assert.equal(monitor.running(), true)
  activity.noteFocus(false)
  assert.equal(monitor.running(), false, 'the app went to the background')

  activity.noteFocus(true)
  dispose()
  assert.equal(monitor.running(), false, 'disposing stops it')
})

test('sleep stops the heartbeat and a wake resets it before it runs again', () => {
  const activity = createPowerActivity({ focused: true })
  const monitor = fakeMonitor()
  gateStallMonitorOnActivity(activity, monitor)
  assert.equal(monitor.running(), true)

  activity.noteSuspend()
  assert.equal(monitor.running(), false)
  activity.noteResume()
  assert.deepEqual(monitor.calls, ['start', 'stop', 'reset', 'start'])

  // A wake whose suspend never arrived still resets the running heartbeat, so
  // the time asleep is not measured as a stall.
  monitor.calls.length = 0
  activity.noteResume()
  assert.deepEqual(monitor.calls, ['reset'])
  assert.equal(monitor.running(), true)

  // Focus lost while asleep: waking does not start it.
  activity.noteSuspend()
  activity.noteFocus(false)
  activity.noteResume()
  assert.equal(monitor.running(), false)
})

test('the poller hears sleep, wake, power source and returning focus', () => {
  const activity = createPowerActivity({ onBattery: true })
  const calls: string[] = []
  const dispose = bindPollerToActivity(activity, {
    suspend: () => calls.push('suspend'),
    wake: () => calls.push('wake'),
    noteFocus: () => calls.push('focus'),
    setOnBattery: (onBattery) => calls.push(`battery:${onBattery}`),
  })
  assert.deepEqual(calls, ['battery:true'], 'the current power source is applied at bind')

  activity.noteSuspend()
  activity.noteResume()
  activity.noteBattery(false)
  activity.noteBattery(false)
  activity.noteFocus(true)
  activity.noteFocus(false)
  assert.deepEqual(calls, ['battery:true', 'suspend', 'wake', 'battery:false', 'focus'])

  dispose()
  activity.noteSuspend()
  assert.equal(calls.length, 5, 'nothing after dispose')
})

test('a listener that throws does not stop the others', () => {
  const activity = createPowerActivity()
  const heard: string[] = []
  activity.onResume(() => {
    throw new Error('boom')
  })
  activity.onResume(() => heard.push('second'))
  const warn = console.warn
  console.warn = () => undefined
  try {
    activity.noteResume()
  } finally {
    console.warn = warn
  }
  assert.deepEqual(heard, ['second'])
})
