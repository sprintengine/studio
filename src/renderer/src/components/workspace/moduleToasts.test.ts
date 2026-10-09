import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ShowToastInput } from '../../store/toastStore'
import { createModuleToastSink } from './moduleToasts'

test("a module toast leads with the module's name and carries at most its one action", async () => {
  const shown: ShowToastInput[] = []
  const dismissed: string[] = []
  const sink = createModuleToastSink({
    show: (input) => {
      shown.push(input)
      return `toast-${shown.length}`
    },
    dismiss: (id) => dismissed.push(id),
  })
  const ran: string[] = []

  const dismissPlain = sink({
    tone: 'good',
    message: 'Decision recorded',
    moduleId: 'acme.log',
    moduleName: 'Decision Log',
  })
  sink({
    tone: 'neutral',
    message: 'Skill installed',
    detail: 'in acme/app',
    action: { label: 'Open', run: () => void ran.push('open') },
    moduleId: 'acme.log',
    moduleName: 'Decision Log',
  })

  assert.equal(shown[0]?.title, 'Decision recorded')
  assert.equal(shown[0]?.description, 'Decision Log', 'the name is the description when there is no detail')
  assert.equal(shown[0]?.actions, undefined, 'no action, no button')
  assert.equal(shown[1]?.description, 'Decision Log · in acme/app')
  assert.equal(shown[1]?.actions?.length, 1)
  assert.equal(shown[1]?.actions?.[0]?.primary, undefined, "a module's button is never the primary")

  shown[1]?.actions?.[0]?.run()
  assert.deepEqual(dismissed, ['toast-2'], 'pressing the action takes the toast down first')
  assert.deepEqual(ran, ['open'])
  dismissPlain()
  assert.deepEqual(dismissed, ['toast-2', 'toast-1'])
})
